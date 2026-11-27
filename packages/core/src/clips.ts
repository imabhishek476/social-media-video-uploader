import fsp from 'node:fs/promises';
import path from 'node:path';
import { GeneratedClipModel, HighlightCandidateModel, LiveSessionModel, StreamerChannelModel, mongoose } from '@shorts/database';
import type { FacecamDetector, ObjectStorage } from '@shorts/integrations';
import type { Logger } from '@shorts/observability';
import { UnrecoverableError } from '@shorts/queue';
import {
  CandidateStatus,
  ProcessingStatus,
  RENDER_STAGE,
  RenderStatus,
  SessionStatus,
  SourceMediaStatus,
  UploadStatus,
  type GeneratedClipDTO,
} from '@shorts/shared-types';
import { loadTranscriptSegments } from './analysis';
import { FONTS_DIR, buildAssCaptions, presetStyle, type CaptionStyle } from './captions';
import { DomainError, isDuplicateKeyError } from './errors';
import { SHORT_HEIGHT, SHORT_WIDTH, captionAnchor, coldOpenRange, concatShorts, extractFrames, renderShort, type FrameBox, type RenderMode } from './render';
import type { SettingsService } from './settings';
import { isShortStyle, pickStyle, styleLook, wordsPerSecond, type MomentType, type StyleSetting } from './styles';

export interface RenderDeps {
  settings: SettingsService;
  storage: ObjectStorage;
  workDir: string;
  /** Finds the webcam overlay for the facecam + gameplay layout. */
  facecam?: FacecamDetector;
  logger?: Logger;
}

/** A RENDERING claim older than this belongs to a crashed worker and may be taken over. */
const STALE_RENDER_MS = 30 * 60 * 1000;

export const clipKeys = (sessionId: string, clipId: string, version: number) => {
  const base = `clips/${sessionId}/${clipId}/v${version}`;
  return { video: `${base}.mp4`, thumbnail: `${base}.jpg`, captions: `${base}.ass` };
};

const sameRange = (a: { startSeconds: number; endSeconds: number }, b: { startSeconds: number; endSeconds: number }) =>
  Math.abs(a.startSeconds - b.startSeconds) < 0.05 && Math.abs(a.endSeconds - b.endSeconds) < 0.05;

export interface RenderSummary {
  rendered: number;
  skipped: number;
  failed: number;
}

/**
 * Phase 5 (spec §6 Workflow G): render every SELECTED highlight of a session
 * into a vertical Short. Idempotent: a clip whose current version already
 * matches the candidate's range is skipped; a trimmed candidate gets a new
 * render version. Each clip is claimed through a unique index, so parallel
 * jobs never render the same clip twice.
 */
export class RenderService {
  constructor(private readonly deps: RenderDeps) {}

  /** `force` re-renders clips that are already up to date (e.g. after changing caption style). */
  async renderSession(sessionId: string, onProgress?: (pct: number) => Promise<void>, opts: { force?: boolean } = {}): Promise<RenderSummary | 'SKIPPED'> {
    const { storage, logger } = this.deps;
    const session = await LiveSessionModel.findById(sessionId).lean();
    if (!session || session.status === SessionStatus.CANCELLED) return 'SKIPPED';
    const candidates = await HighlightCandidateModel.find({ liveSessionId: sessionId, status: CandidateStatus.SELECTED }).sort({ score: -1 }).lean();

    // Work out which candidates need a (re-)render and claim them.
    const claimed: Array<{ clipId: string; version: number; candidate: (typeof candidates)[number] }> = [];
    let skipped = 0;
    for (const c of candidates) {
      const latest = await GeneratedClipModel.findOne({ highlightCandidateId: c._id }).sort({ renderVersion: -1 }).lean();
      if (latest && sameRange(latest, c) && latest.renderStatus === RenderStatus.RENDERED && (!opts.force || latest.uploadStatus !== UploadStatus.NOT_UPLOADED)) {
        skipped++;
        continue;
      }
      const claim = await this.claim(String(session.streamerChannelId), sessionId, c, latest);
      if (claim) claimed.push({ ...claim, candidate: c });
      else skipped++;
    }
    if (!claimed.length) {
      await this.refreshSession(sessionId);
      return { rendered: 0, skipped, failed: 0 };
    }

    if (session.sourceMedia?.status !== SourceMediaStatus.READY || !session.sourceMedia.storageKey) {
      const msg = 'The source recording is no longer stored (expired or missing), so clips cannot be rendered.';
      await GeneratedClipModel.updateMany({ _id: { $in: claimed.map((c) => c.clipId) } }, { $set: { renderStatus: RenderStatus.RENDER_FAILED, lastError: msg } });
      await this.refreshSession(sessionId);
      throw new UnrecoverableError(msg);
    }

    await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { processingStatus: ProcessingStatus.RUNNING, processingStage: RENDER_STAGE } });
    const { clips: clipSettings, subtitles } = (await this.deps.settings.getValues()).values;
    // A mode chosen for this session ("Re-render with layout…") wins over Settings.
    // Short style (Phase 8.6): regenerate choice > streamer > Settings. A session regenerated
    // with a fixed layout before styles existed keeps that layout (styleSetting = null).
    const streamer = await StreamerChannelModel.findById(session.streamerChannelId).select('preferences').lean();
    const streamerStyle = (streamer?.preferences as { shortStyle?: string | null } | undefined)?.shortStyle;
    const sessionStyle = (session as { shortStyle?: string | null }).shortStyle;
    const styleSetting: StyleSetting | null =
      sessionStyle === 'AUTO' || isShortStyle(sessionStyle)
        ? sessionStyle
        : session.reframingMode
          ? null
          : streamerStyle === 'AUTO' || isShortStyle(streamerStyle)
            ? streamerStyle
            : (clipSettings.shortStyle ?? 'AUTO');
    const wanted = (styleSetting ? 'GAMEPLAY' : null) ?? session.reframingMode ?? clipSettings.reframingMode;
    const configured: RenderMode = (['BLUR_FIT', 'FACECAM_SPLIT', 'GAMEPLAY'] as string[]).includes(wanted) ? (wanted as RenderMode) : 'CENTER_CROP';
    let mode: RenderMode = configured;
    let facecam: FrameBox | null = null;
    const style: CaptionStyle = presetStyle(subtitles.captionStyle ?? 'CUSTOM', {
      fontFamily: subtitles.fontFamily,
      fontSize: subtitles.fontSize,
      primaryColor: subtitles.primaryColor,
      highlightColor: subtitles.highlightColor,
      position: subtitles.position,
    });
    const hookMode = subtitles.hookOverlay ?? 'OFF';

    const work = path.join(this.deps.workDir, `render-${sessionId}-${process.pid}`);
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    let rendered = 0;
    let failed = 0;
    try {
      const source = path.join(work, `source${path.extname(session.sourceMedia.storageKey)}`);
      try {
        await storage.download(session.sourceMedia.storageKey, source);
      } catch (err) {
        // Release the claims so the retry can take them again.
        await GeneratedClipModel.updateMany({ _id: { $in: claimed.map((c) => c.clipId) } }, { $set: { renderStatus: RenderStatus.PENDING, renderStartedAt: null } });
        throw err;
      }
      const needsFacecam = styleSetting ? styleSetting !== 'CLEAN' && styleSetting !== 'STORY' : configured === 'FACECAM_SPLIT' || configured === 'GAMEPLAY';
      if (needsFacecam) {
        facecam = await this.resolveFacecam(sessionId, source, session.sourceMedia.durationSeconds ?? 0, work);
        // No webcam (IRL, just chatting, or not found): split shows the whole frame; gameplay fills with the game.
        if (!facecam) mode = configured === 'GAMEPLAY' ? 'CENTER_CROP' : 'BLUR_FIT';
      }
      await onProgress?.(10);

      for (const [i, { clipId, version, candidate: c }] of claimed.entries()) {
        const keys = clipKeys(sessionId, clipId, version);
        const files = {
          video: path.join(work, `${clipId}.mp4`),
          thumb: path.join(work, `${clipId}.jpg`),
          ass: path.join(work, `${clipId}.ass`),
          main: path.join(work, `${clipId}-main.mp4`),
          teaser: path.join(work, `${clipId}-teaser.mp4`),
          teaserThumb: path.join(work, `${clipId}-teaser.jpg`),
          teaserAss: path.join(work, `${clipId}-teaser.ass`),
        };
        try {
          const allSegments = await loadTranscriptSegments(sessionId, c.startSeconds, c.endSeconds);
          // Pick this Short's style and what it shows.
          let clipMode: RenderMode = mode;
          let clipFacecam = facecam;
          let clipHook: 'ALWAYS' | 'INTRO' | 'OFF' = hookMode;
          let showReaction = true;
          let segments = allSegments;
          let chosen: { style: string; reason: string } | null = null;
          if (styleSetting) {
            const wps = wordsPerSecond(allSegments, c.startSeconds, c.endSeconds);
            const momentType = (c as { momentType?: MomentType | null }).momentType ?? null;
            const wantsFace = facecam && (styleSetting === 'REACTION' || styleSetting === 'GAMEPLAY' || (styleSetting === 'AUTO' && momentType !== 'story' && wps >= 0.6));
            const faceVisible = wantsFace ? await this.faceInClip(source, c.startSeconds, c.endSeconds, path.join(work, `face-${clipId}`)) : false;
            chosen = styleSetting === 'AUTO' ? pickStyle({ momentType, faceVisible, wordsPerSecond: wps }) : { style: styleSetting, reason: 'chosen style' };
            const look = styleLook(chosen.style as Parameters<typeof styleLook>[0], faceVisible);
            clipMode = look.mode;
            clipFacecam = look.useFacecam ? facecam : null;
            clipHook = look.hook === 'OFF' || hookMode === 'OFF' ? 'OFF' : look.hook === 'TITLE' ? 'ALWAYS' : hookMode;
            showReaction = look.reaction;
            if (!look.wordCaptions) segments = [];
          }
          const hook = clipHook !== 'OFF' && c.hook ? { text: c.hook, mode: clipHook } : null;
          const captionStyle = { ...style, anchorY: captionAnchor(clipMode, style.position) };
          const teaser = clipSettings.coldOpen !== 'OFF' ? coldOpenRange(c.startSeconds, c.endSeconds, c.keyMomentSeconds) : null;
          // Our reaction sticker appears once the hook is gone (top), or at the bottom when the hook stays.
          const reactionText = showReaction && subtitles.reactionSticker !== 'OFF' ? (c as { reaction?: string | null }).reaction : null;
          const reaction = reactionText ? { text: reactionText, fromSeconds: clipHook === 'ALWAYS' ? 1.5 : teaser ? 2.5 : 4.2, at: (clipHook === 'ALWAYS' ? 'BOTTOM' : 'TOP') as 'TOP' | 'BOTTOM' } : null;
          // With a cold open the hook shows over the flash-forward, so the main part only keeps it when ALWAYS.
          const mainHook = teaser && hook?.mode === 'INTRO' ? null : hook;
          await fsp.writeFile(files.ass, buildAssCaptions(segments, c.startSeconds, c.endSeconds, captionStyle, mainHook, reaction));
          const base = { sourcePath: source, fontsDir: FONTS_DIR, mode: clipMode, facecam: clipFacecam, keyMomentSeconds: c.keyMomentSeconds ?? null };
          let out = await renderShort({
            ...base,
            outPath: teaser ? files.main : files.video,
            thumbnailPath: files.thumb,
            captionsPath: segments.length || mainHook || reaction ? files.ass : null,
            startSeconds: c.startSeconds,
            endSeconds: c.endSeconds,
          });
          if (teaser) {
            const teaserSegments = segments.filter((s) => s.endSeconds > teaser.start && s.startSeconds < teaser.end);
            await fsp.writeFile(files.teaserAss, buildAssCaptions(teaserSegments, teaser.start, teaser.end, captionStyle, hook ? { text: hook.text, mode: 'ALWAYS' } : null));
            const t = await renderShort({ ...base, outPath: files.teaser, thumbnailPath: files.teaserThumb, captionsPath: files.teaserAss, startSeconds: teaser.start, endSeconds: teaser.end });
            await concatShorts([files.teaser, files.main], files.video);
            const { size } = await fsp.stat(files.video);
            out = { durationSeconds: Math.round((out.durationSeconds + t.durationSeconds) * 10) / 10, sizeBytes: size };
          }
          await storage.upload(keys.video, files.video, 'video/mp4');
          await storage.upload(keys.thumbnail, files.thumb, 'image/jpeg');
          await storage.upload(keys.captions, files.ass, 'text/plain');
          await GeneratedClipModel.updateOne(
            { _id: clipId },
            {
              $set: {
                renderStatus: RenderStatus.RENDERED,
                storageKey: keys.video,
                thumbnailKey: keys.thumbnail,
                subtitleKey: keys.captions,
                durationSeconds: out.durationSeconds,
                fileSizeBytes: out.sizeBytes,
                width: SHORT_WIDTH,
                height: SHORT_HEIGHT,
                reframingMode: clipMode,
                shortStyle: chosen?.style ?? null,
                styleReason: chosen?.reason ?? null,
                renderedAt: new Date(),
                lastError: null,
              },
            },
          );
          await this.removeOlderVersions(c._id, version);
          rendered++;
          logger?.info({ liveSessionId: sessionId, clipId, version, sizeBytes: out.sizeBytes, mode: clipMode, style: chosen }, 'Short rendered');
        } catch (err) {
          failed++;
          await GeneratedClipModel.updateOne({ _id: clipId }, { $set: { renderStatus: RenderStatus.RENDER_FAILED, lastError: (err as Error).message.slice(0, 500) } });
          logger?.error({ err, liveSessionId: sessionId, clipId }, 'Short render failed');
        } finally {
          await Promise.all(Object.values(files).map((f) => fsp.rm(f, { force: true })));
        }
        await onProgress?.(10 + Math.round(((i + 1) / claimed.length) * 90));
      }
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
      await this.refreshSession(sessionId);
    }
    return { rendered, skipped, failed };
  }

  /**
   * The session's facecam box: a manual or earlier detection wins; otherwise
   * three frames go to the vision model once and the result (or "none") is
   * stored so later renders don't ask again. Detection errors are not
   * stored, so the next render retries.
   */
  /** Is the streamer's webcam showing during this clip? (Cut-scenes, hidden cams, BRB screens.) */
  private async faceInClip(sourcePath: string, start: number, end: number, dir: string): Promise<boolean> {
    if (!this.deps.facecam) return true;
    try {
      const frames = await extractFrames(sourcePath, [0.3, 0.7].map((p) => start + p * (end - start)), dir);
      return Boolean(await this.deps.facecam.detect(frames));
    } catch (err) {
      this.deps.logger?.warn({ err: (err as Error).message }, 'Face check failed; assuming the webcam is visible');
      return true;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async resolveFacecam(sessionId: string, sourcePath: string, durationSeconds: number, work: string): Promise<FrameBox | null> {
    const s = await LiveSessionModel.findById(sessionId).select('facecam').lean();
    const f = s?.facecam;
    if (f?.source === 'none') return null;
    if (f?.source && f.w && f.h) return { x: f.x ?? 0, y: f.y ?? 0, w: f.w, h: f.h };
    if (!this.deps.facecam || durationSeconds < 5) return null;
    try {
      const frames = await extractFrames(sourcePath, [0.25, 0.5, 0.75].map((p) => p * durationSeconds), path.join(work, 'frames'));
      const box = await this.deps.facecam.detect(frames);
      await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { facecam: box ? { ...box, source: 'detected', detectedAt: new Date() } : { source: 'none', detectedAt: new Date() } } });
      this.deps.logger?.info({ liveSessionId: sessionId, box, detector: this.deps.facecam.name }, box ? 'Facecam detected' : 'No facecam found');
      return box;
    } catch (err) {
      this.deps.logger?.warn({ err: (err as Error).message, liveSessionId: sessionId }, 'Facecam detection failed; using the full-frame layout this time');
      return null;
    }
  }

  /** Claim a clip for rendering: a new version, a failed one, or a stale in-progress one. */
  private async claim(
    streamerChannelId: string,
    sessionId: string,
    c: { _id: mongoose.Types.ObjectId; startSeconds: number; endSeconds: number; score: number },
    latest: { _id: mongoose.Types.ObjectId; renderVersion: number; renderStatus: string; startSeconds: number; endSeconds: number; renderStartedAt?: Date | null; uploadStatus: string } | null,
  ): Promise<{ clipId: string; version: number } | null> {
    const now = new Date();
    const fields = { renderStatus: RenderStatus.RENDERING, renderStartedAt: now, lastError: null };
    const replaceRendered = latest?.renderStatus === RenderStatus.RENDERED; // forced re-render → new version
    if (latest && sameRange(latest, c) && latest.uploadStatus === UploadStatus.NOT_UPLOADED && !replaceRendered) {
      // Same range: retry in place if failed/pending or abandoned.
      const res = await GeneratedClipModel.findOneAndUpdate(
        {
          _id: latest._id,
          $or: [
            { renderStatus: { $in: [RenderStatus.RENDER_FAILED, RenderStatus.PENDING] } },
            { renderStatus: RenderStatus.RENDERING, renderStartedAt: { $lt: new Date(now.getTime() - STALE_RENDER_MS) } },
          ],
        },
        { $set: fields },
      ).lean();
      return res ? { clipId: String(res._id), version: res.renderVersion } : null;
    }
    if (latest && sameRange(latest, c) && latest.uploadStatus !== UploadStatus.NOT_UPLOADED) return null; // already uploaded: never re-render silently
    const version = (latest?.renderVersion ?? 0) + 1;
    try {
      const doc = await GeneratedClipModel.create({
        liveSessionId: sessionId,
        streamerChannelId,
        highlightCandidateId: c._id,
        startSeconds: c.startSeconds,
        endSeconds: c.endSeconds,
        durationSeconds: Math.round((c.endSeconds - c.startSeconds) * 10) / 10,
        highlightScore: c.score,
        renderVersion: version,
        ...fields,
      });
      return { clipId: String(doc._id), version };
    } catch (err) {
      if (isDuplicateKeyError(err)) return null; // another worker claimed this version
      throw err;
    }
  }

  /** A newer render replaces older, never-uploaded versions (files and records). */
  private async removeOlderVersions(candidateId: mongoose.Types.ObjectId, version: number) {
    const old = await GeneratedClipModel.find({ highlightCandidateId: candidateId, renderVersion: { $lt: version }, uploadStatus: UploadStatus.NOT_UPLOADED }).lean();
    for (const o of old) {
      for (const key of [o.storageKey, o.thumbnailKey, o.subtitleKey]) if (key) await this.deps.storage.delete(key).catch(() => undefined);
      await GeneratedClipModel.deleteOne({ _id: o._id });
    }
  }

  private async refreshSession(sessionId: string) {
    const clipCount = await GeneratedClipModel.countDocuments({ liveSessionId: sessionId, renderStatus: RenderStatus.RENDERED });
    await LiveSessionModel.updateOne(
      { _id: sessionId, processingStage: RENDER_STAGE },
      { $set: { processingStatus: ProcessingStatus.COMPLETED, processingStage: null } },
    );
    await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { clipCount } });
  }
}

/** Read side for rendered clips (API). */
export class ClipService {
  constructor(private readonly storage: ObjectStorage) {}

  /**
   * Clean slate before regenerating: deletes every Short of the session that
   * was not published (files, captions, thumbnails and records), optionally
   * sets the session's layout, and returns how many were removed. Shorts
   * already on YouTube or Instagram are kept so they are never uploaded twice.
   */
  async resetSession(sessionId: string, reframingMode?: string | null, shortStyle?: string | null): Promise<{ removed: number; kept: number }> {
    const clips = await GeneratedClipModel.find({ liveSessionId: sessionId }).lean();
    let removed = 0;
    let kept = 0;
    for (const c of clips) {
      const published = c.uploadStatus !== UploadStatus.NOT_UPLOADED || (c as { instagram?: { status?: string } }).instagram?.status === 'PUBLISHED';
      if (published) {
        kept++;
        continue;
      }
      for (const key of [c.storageKey, c.thumbnailKey, c.subtitleKey]) if (key) await this.storage.delete(key).catch(() => undefined);
      await GeneratedClipModel.deleteOne({ _id: c._id });
      removed++;
    }
    const set: Record<string, unknown> = {};
    if (reframingMode !== undefined) set.reframingMode = reframingMode;
    // A style replaces a fixed layout (and vice versa).
    if (shortStyle !== undefined) Object.assign(set, { shortStyle, ...(shortStyle ? { reframingMode: null } : {}) });
    else if (reframingMode) set.shortStyle = null;
    if (Object.keys(set).length) await LiveSessionModel.updateOne({ _id: sessionId }, { $set: set });
    const clipCount = await GeneratedClipModel.countDocuments({ liveSessionId: sessionId, renderStatus: RenderStatus.RENDERED });
    await LiveSessionModel.updateOne({ _id: sessionId }, { $set: { clipCount } });
    return { removed, kept };
  }


  /** Latest version of each clip in a session. */
  async listForSession(sessionId: string): Promise<GeneratedClipDTO[]> {
    if (!mongoose.isValidObjectId(sessionId)) throw DomainError.notFound('Live session');
    const all = await GeneratedClipModel.find({ liveSessionId: sessionId }).sort({ renderVersion: -1 }).lean();
    const seen = new Set<string>();
    return all.filter((c) => !seen.has(String(c.highlightCandidateId)) && seen.add(String(c.highlightCandidateId))).map(toClipDTO);
  }

  async get(id: string) {
    if (!mongoose.isValidObjectId(id)) throw DomainError.notFound('Clip');
    const c = await GeneratedClipModel.findById(id).lean();
    if (!c) throw DomainError.notFound('Clip');
    return c;
  }

  async mediaUrls(id: string, ttlSeconds: number, localUrl: (kind: 'video' | 'thumbnail') => string) {
    const c = await this.get(id);
    if (c.filesExpiredAt) throw new DomainError('CLIP_FILES_EXPIRED', 'The rendered file was deleted by retention (Settings → Storage retention)', 410);
    if (c.renderStatus !== RenderStatus.RENDERED || !c.storageKey) throw new DomainError('CLIP_NOT_RENDERED', 'This clip has not been rendered yet', 409);
    if (this.storage.name === 'local') return { videoUrl: localUrl('video'), thumbnailUrl: c.thumbnailKey ? localUrl('thumbnail') : null, expiresAt: null };
    return {
      videoUrl: await this.storage.signedReadUrl(c.storageKey, ttlSeconds),
      thumbnailUrl: c.thumbnailKey ? await this.storage.signedReadUrl(c.thumbnailKey, ttlSeconds) : null,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toClipDTO(c: any): GeneratedClipDTO {
  return {
    id: String(c._id),
    liveSessionId: String(c.liveSessionId),
    highlightCandidateId: String(c.highlightCandidateId),
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
    durationSeconds: c.durationSeconds,
    highlightScore: c.highlightScore ?? null,
    reframingMode: c.reframingMode,
    shortStyle: (c as { shortStyle?: string | null }).shortStyle ?? null,
    styleReason: (c as { styleReason?: string | null }).styleReason ?? null,
    renderStatus: c.renderStatus,
    renderVersion: c.renderVersion,
    fileSizeBytes: c.fileSizeBytes ?? null,
    width: c.width ?? null,
    height: c.height ?? null,
    renderedAt: c.renderedAt ? c.renderedAt.toISOString() : null,
    approvalStatus: c.approvalStatus,
    approvedAt: c.approvedAt ? c.approvedAt.toISOString() : null,
    uploadStatus: c.uploadStatus,
    title: c.title ?? '',
    description: c.description ?? '',
    tags: c.tags ?? [],
    metadataEditedByUser: Boolean(c.metadataEditedByUser),
    scheduledPublishAt: c.scheduledPublishAt ? c.scheduledPublishAt.toISOString() : null,
    goLiveAt: c.goLiveAt ? c.goLiveAt.toISOString() : null,
    youtubeVideoId: c.youtubeVideoId ?? null,
    youtubeUrl: c.youtubeUrl ?? null,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
    stats: c.stats?.fetchedAt
      ? {
          views: c.stats.views ?? 0,
          likes: c.stats.likes ?? 0,
          comments: c.stats.comments ?? 0,
          privacyStatus: c.stats.privacyStatus ?? null,
          fetchedAt: c.stats.fetchedAt.toISOString(),
          averageViewPercentage: c.stats.averageViewPercentage ?? null,
          subscribersGained: c.stats.subscribersGained ?? null,
        }
      : null,
    firstComment: c.firstComment?.status ? { status: c.firstComment.status as 'POSTED' | 'FAILED', text: c.firstComment.text ?? '', lastError: c.firstComment.lastError ?? null } : null,
    instagram: {
      status: c.instagram?.status ?? 'NOT_POSTED',
      permalink: c.instagram?.permalink ?? null,
      publishedAt: c.instagram?.publishedAt ? c.instagram.publishedAt.toISOString() : null,
      lastError: c.instagram?.lastError ?? null,
    },
    filesExpired: Boolean(c.filesExpiredAt),
    lastError: c.lastError ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
