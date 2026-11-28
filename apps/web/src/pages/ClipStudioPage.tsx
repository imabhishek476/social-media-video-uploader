import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Card from '@mui/material/Card';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Save from '@mui/icons-material/Save';
import Search from '@mui/icons-material/Search';
import Download from '@mui/icons-material/Download';
import Movie from '@mui/icons-material/Movie';
import { UserRole, type GeneratedClipDTO, type HighlightCandidateDTO, type TranscriptSegmentDTO } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useClipMedia, useClips, useHighlights, useMe, useRenderSession, useSession, useSessions, useSetFacecam, useSetSessionCategory, useSettings, useSourcePreview, useTranscript, useUpdateHighlight } from '../api/hooks';
import { FacecamOverlay } from '../components/FacecamOverlay';
import { CandidateCard } from '../components/CandidateCard';
import { STAGES, StageBar, stageMeta, stageOf, type Stage } from '../components/StagePipeline';
import { PageHeader } from '../components/PageHeader';
import { PublishPanel } from '../components/PublishPanel';
import { RegenerateShortsButton } from '../components/RegenerateShortsButton';
import { StatusChip } from '../components/StatusChip';
import { formatBytes, formatClock, formatDateTime, formatUsd } from '../lib/format';

const STAGE_IDS: Stage[] = ['REVIEW', 'MAKING', 'READY', 'PUBLISHED', 'DISCARDED'];
const isStage = (v: string | null): v is Stage => STAGE_IDS.includes(v as Stage);
/** Selected but not rendered yet (or out of date / failed): "Render selected" makes these. */
const needsRenderOf = (c: HighlightCandidateDTO, clip: GeneratedClipDTO | undefined) =>
  stageOf(c, clip) === 'MAKING' && clip?.renderStatus !== 'RENDERING' && clip?.renderStatus !== 'PENDING';
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

const STYLE_NAMES: Record<string, string> = { REACTION: 'Reaction', GAMEPLAY: 'Gameplay', CLEAN: 'Clean gameplay', STORY: 'Story' };

export function ClipStudioPage() {
  const { data: me } = useMe();
  const canEdit = me?.role === UserRole.ADMIN;
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('session');
  const sessions = useSessions({ page: 1, pageSize: 50, status: 'HIGHLIGHTS_READY' });
  const session = useSession(sessionId);
  const highlights = useHighlights(sessionId);
  const preview = useSourcePreview(sessionId);
  const transcript = useTranscript(sessionId);
  const update = useUpdateHighlight();
  const renderJob = useRenderSession();
  const [view, setView] = useState<'source' | 'short'>('source');

  const stageParam = params.get('stage');
  // Highlights the user just moved stay where they were (marked "Moved to…") until the stage changes.
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ id: string; text: string; undo: HighlightCandidateDTO['status']; to: Stage } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [showFrame, setShowFrame] = useState(true);
  const [editFacecam, setEditFacecam] = useState(false);
  const settings = useSettings();
  const setFacecam = useSetFacecam();
  const layoutMode = session.data?.reframingMode ?? settings.data?.clips.reframingMode ?? 'CENTER_CROP';
  const splitLayout = layoutMode === 'FACECAM_SPLIT' || layoutMode === 'GAMEPLAY';
  const [playhead, setPlayhead] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceHeight, setWorkspaceHeight] = useState<number | null>(null);
  // Height = screen height minus where the workspace starts and the page's bottom padding.
  // Measured after every render (content above can load or wrap) and on window resize.
  const measureWorkspace = () => {
    const el = workspaceRef.current;
    if (!el) return;
    const main = el.closest('main');
    const bottomPad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const h = Math.max(420, Math.floor(window.innerHeight - top - bottomPad));
    setWorkspaceHeight((old) => (old === h ? old : h));
  };
  useLayoutEffect(measureWorkspace);
  useEffect(() => {
    const onResize = () => measureWorkspace();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  /** Phones: the editor is above the list, so bring it into view when a highlight is picked. */
  const showEditor = () => {
    if (window.matchMedia('(max-width: 899.95px)').matches) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else editorRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Default to the most recent analysed session.
  useEffect(() => {
    const first = sessions.data?.items[0];
    if (!sessionId && first) setParams({ session: first.id }, { replace: true });
  }, [sessionId, sessions.data, setParams]);

  const items = highlights.data ?? [];
  const active = items.find((c) => c.id === activeId) ?? null;
  const renderingNow = session.data?.processingStage === 'RENDERING';
  const clips = useClips(sessionId, renderingNow);
  const clipByCandidate = useMemo(() => new Map((clips.data ?? []).map((c) => [c.highlightCandidateId, c])), [clips.data]);
  const stageById = useMemo(() => new Map(items.map((c) => [c.id, stageOf(c, clipByCandidate.get(c.id))])), [items, clipByCandidate]);
  const counts = useMemo(() => {
    const out = { REVIEW: 0, MAKING: 0, READY: 0, PUBLISHED: 0, DISCARDED: 0 } as Record<Stage, number>;
    for (const st of stageById.values()) out[st]++;
    return out;
  }, [stageById]);
  // Open on the first stage with work in it, unless the URL says otherwise.
  const firstBusy = (['REVIEW', 'MAKING', 'READY', 'PUBLISHED'] as Stage[]).find((x) => counts[x] > 0) ?? 'REVIEW';
  const stage: Stage = isStage(stageParam) ? stageParam : firstBusy;
  const setStage = (next: Stage) => {
    setPinned(new Set());
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('stage', next);
      return n;
    }, { replace: true });
  };
  const visible = items.filter((c) => stageById.get(c.id) === stage || pinned.has(c.id));
  // Fix the stage once loaded, so the list never jumps to another stage as counts change.
  useEffect(() => {
    if (!isStage(stageParam) && highlights.isSuccess && clips.isSuccess) setStage(firstBusy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageParam, highlights.isSuccess, clips.isSuccess]);
  const anyRendering = (clips.data ?? []).some((c) => c.renderStatus === 'RENDERING');
  const activeClip = active ? clipByCandidate.get(active.id) : undefined;
  const activeShort = activeClip?.renderStatus === 'RENDERED' ? activeClip : undefined;
  const needsRender = items.filter((c) => needsRenderOf(c, clipByCandidate.get(c.id))).length;
  const readyCount = (clips.data ?? []).filter((c) => c.renderStatus === 'RENDERED').length;

  const changeStatus = (c: HighlightCandidateDTO, status: HighlightCandidateDTO['status'], undoable = true) =>
    update.mutate(
      { id: c.id, input: { status } },
      {
        onSuccess: (u) => {
          const to = stageOf(u, clipByCandidate.get(u.id));
          setPinned((p) => new Set(p).add(u.id));
          if (undoable) setToast({ id: u.id, text: `${(c.hook || 'Highlight').slice(0, 40)} → ${stageMeta(to).label}`, undo: c.status, to });
        },
      },
    );

  const watch = (c: HighlightCandidateDTO) => {
    setActiveId(c.id);
    setDraft({ start: c.startSeconds.toFixed(1), end: c.endSeconds.toFixed(1) });
    if (clipByCandidate.get(c.id)?.renderStatus === 'RENDERED') setView('short');
    showEditor();
  };

  // Keyboard: J/K or ↓/↑ move through the list, Enter plays, S makes a Short, X skips.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || !visible.length) return;
    const i = visible.findIndex((c) => c.id === activeId);
    const k = e.key.toLowerCase();
    if (k === 'j' || k === 'arrowdown' || k === 'k' || k === 'arrowup') {
      e.preventDefault();
      const next = visible[Math.max(0, Math.min(visible.length - 1, i + (k === 'j' || k === 'arrowdown' ? 1 : -1)))]!;
      open(next);
      document.getElementById(`hl-${next.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (k === 'enter' && active) open(active, true);
    else if (canEdit && active && k === 's' && active.status !== 'SELECTED' && stageById.get(active.id) !== 'PUBLISHED') changeStatus(active, 'SELECTED');
    else if (canEdit && active && k === 'x' && active.status !== 'DISCARDED' && stageById.get(active.id) !== 'PUBLISHED') changeStatus(active, 'DISCARDED');
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const open = (c: HighlightCandidateDTO, play = false) => {
    setActiveId(c.id);
    if (view === 'short' && clipByCandidate.get(c.id)?.renderStatus !== 'RENDERED') setView('source');
    setDraft({ start: c.startSeconds.toFixed(1), end: c.endSeconds.toFixed(1) });
    seek(c.startSeconds, play ? c.endSeconds : null);
  };

  const seek = (t: number, until: number | null = null) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    stopAt.current = until;
    if (until !== null) void v.play().catch(() => undefined);
  };

  const draftStart = Number(draft.start);
  const draftEnd = Number(draft.end);
  const draftValid = Number.isFinite(draftStart) && Number.isFinite(draftEnd) && draftEnd > draftStart;
  const dirty = active && draftValid && (Math.abs(draftStart - active.startSeconds) > 0.05 || Math.abs(draftEnd - active.endSeconds) > 0.05);

  const s = session.data;

  return (
    <>
      <PageHeader title="Clip Studio" subtitle="Review the AI-picked highlights, trim them, and choose which ones become Shorts." />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2, alignItems: { sm: 'center' } }}>
        <TextField
          select
          size="small"
          label="Session"
          value={sessionId ?? ''}
          onChange={(e) => {
            setActiveId(null);
            setParams({ session: e.target.value });
          }}
          sx={{ minWidth: { sm: 320 }, width: { xs: '100%', sm: 'auto' }, maxWidth: '100%' }}
        >
          {sessionId && !sessions.data?.items.some((i) => i.id === sessionId) && s && (
            <MenuItem value={sessionId}>
              {s.streamer.displayName} — {s.title || 'Untitled'}
            </MenuItem>
          )}
          {(sessions.data?.items ?? []).map((i) => (
            <MenuItem key={i.id} value={i.id}>
              {i.streamer.displayName} — {i.title || 'Untitled'} ({i.highlightCount})
            </MenuItem>
          ))}
        </TextField>
        {s && (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <StatusChip status={s.processingStage ?? s.status} />
            <CategoryPicker sessionId={s.id} value={s.category} source={s.categorySource} canEdit={canEdit} />
            <Typography variant="body2" color="text.secondary">
              {formatDateTime(s.startedAt)} · AI cost {formatUsd(s.estimatedCostUsd)}
            </Typography>
            <Button size="small" component={RouterLink} to={`/sessions?session=${s.id}`}>
              Session details
            </Button>
          </Stack>
        )}
      </Stack>

      {sessions.isSuccess && sessions.data.items.length === 0 && !sessionId && (
        <Alert severity="info">
          No analysed sessions yet. When a stream ends and its recording is stored, it is transcribed and analysed automatically; the highlights then appear here.
        </Alert>
      )}
      {s && s.status !== 'HIGHLIGHTS_READY' && (
        <Alert severity={s.status === 'FAILED' ? 'error' : 'info'} sx={{ mb: 2 }}>
          {s.status === 'PROCESSING' ? `This session is being processed (${(s.processingStage ?? 'running').toLowerCase()}). Highlights appear when it finishes.` : (s.lastError ?? `Session status: ${s.status}`)}
        </Alert>
      )}
      {s?.status === 'HIGHLIGHTS_READY' && s.lastError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {s.lastError}
        </Alert>
      )}

      {sessionId && (
        <Grid
          container
          spacing={2}
          ref={workspaceRef}
          // Desktop: the workspace fills the rest of the screen (no page scroll); the editor (left)
          // and the list (right) scroll on their own.
          sx={{ height: { md: workspaceHeight ? `${workspaceHeight}px` : 'calc(100vh - 290px)' } }}
        >
          <Grid ref={editorRef} size={{ xs: 12, md: 7 }} sx={{ height: { md: '100%' }, overflowY: { md: 'auto' }, pr: { md: 0.5 }, scrollMarginTop: 72 }}>
            <Card variant="outlined" sx={{ p: 1.5 }}>
              <Tabs value={view} onChange={(_, v: 'source' | 'short') => setView(v)} sx={{ minHeight: 36, mb: 1 }}>
                <Tab value="source" label="Source" sx={{ minHeight: 36 }} />
                <Tab value="short" label="Rendered Short" disabled={!activeShort} sx={{ minHeight: 36 }} />
              </Tabs>
              {view === 'short' && activeShort ? (
                <ShortPlayer clip={activeShort} />
              ) : (
              <Box sx={{ position: 'relative', bgcolor: 'common.black', borderRadius: 1, overflow: 'hidden', aspectRatio: '16 / 9' }}>
                {preview.data ? (
                  <video
                    ref={video}
                    src={preview.data.url}
                    controls
                    preload="metadata"
                    style={{ width: '100%', height: '100%', display: 'block' }}
                    onTimeUpdate={(e) => {
                      const t = e.currentTarget.currentTime;
                      setPlayhead(t);
                      if (stopAt.current !== null && t >= stopAt.current) {
                        e.currentTarget.pause();
                        stopAt.current = null;
                      }
                    }}
                  />
                ) : preview.isError ? (
                  <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center', p: 2 }}>
                    <Typography color="grey.400" variant="body2" sx={{ textAlign: 'center' }}>
                      Preview unavailable: {describeError(preview.error)}
                    </Typography>
                  </Stack>
                ) : (
                  <Skeleton variant="rectangular" sx={{ height: '100%', bgcolor: 'grey.900' }} />
                )}
                {splitLayout && preview.data && (
                  <FacecamOverlay
                    box={s?.facecam && s.facecam.source !== 'none' ? s.facecam : null}
                    editing={editFacecam}
                    onDraw={(box) => {
                      if (!s) return;
                      setFacecam.mutate({ id: s.id, box: { x: +box.x.toFixed(4), y: +box.y.toFixed(4), w: +box.w.toFixed(4), h: +box.h.toFixed(4) } });
                      setEditFacecam(false);
                    }}
                  />
                )}
                {showFrame && preview.data && !splitLayout && (
                  // Where a centre-cropped 9:16 Short would sit.
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 0,
                      bottom: 40,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      aspectRatio: '9 / 16',
                      border: '2px dashed rgba(255,255,255,0.7)',
                      boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </Box>
              )}

              <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 72 }}>
                  {formatClock(playhead, true)}
                </Typography>
                {!splitLayout && (
                  <FormControlLabel control={<Switch size="small" checked={showFrame} onChange={(e) => setShowFrame(e.target.checked)} />} label={<Typography variant="body2">Show Shorts frame</Typography>} />
                )}
                {splitLayout && s && (
                  <>
                    <Typography variant="body2" color="text.secondary">
                      Facecam:{' '}
                      {s.facecam?.source === 'manual'
                        ? 'set by hand'
                        : s.facecam?.source === 'detected'
                          ? 'detected'
                          : s.facecam?.source === 'none'
                            ? 'none found (full-frame layout)'
                            : 'detected on next render'}
                    </Typography>
                    {canEdit && (
                      <>
                        <Button size="small" variant={editFacecam ? 'contained' : 'text'} color={editFacecam ? 'warning' : 'primary'} onClick={() => setEditFacecam((v) => !v)}>
                          {editFacecam ? 'Drag over the webcam… (cancel)' : 'Draw facecam box'}
                        </Button>
                        {s.facecam && (
                          <Button size="small" disabled={setFacecam.isPending} onClick={() => setFacecam.mutate({ id: s.id, box: null })}>
                            Detect again
                          </Button>
                        )}
                      </>
                    )}
                  </>
                )}
              </Stack>
              {splitLayout && setFacecam.isSuccess && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  Facecam updated. Press “Re-render all” to apply it to the Shorts.
                </Alert>
              )}

              {active ? (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="overline" color="text.secondary">
                    Selected clip
                  </Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 0.5, alignItems: { sm: 'flex-start' } }}>
                    {(['start', 'end'] as const).map((field) => (
                      <TextField
                        key={field}
                        size="small"
                        type="number"
                        label={field === 'start' ? 'Start (s)' : 'End (s)'}
                        value={draft[field]}
                        disabled={!canEdit}
                        onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                        slotProps={{
                          htmlInput: { step: 0.1, min: 0 },
                          input: {
                            endAdornment: canEdit ? (
                              <InputAdornment position="end">
                                <Button size="small" sx={{ minWidth: 0, px: 0.5 }} onClick={() => setDraft((d) => ({ ...d, [field]: playhead.toFixed(1) }))}>
                                  Use playhead
                                </Button>
                              </InputAdornment>
                            ) : undefined,
                          },
                        }}
                        sx={{ width: { sm: 210 } }}
                      />
                    ))}
                  </Stack>
                  <Typography variant="caption" color={draftValid ? 'text.secondary' : 'error'} component="p" sx={{ mt: 0.5 }}>
                    {draftValid ? `${(draftEnd - draftStart).toFixed(1)} seconds` : 'End must be after start'}
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                    <Button variant="outlined" startIcon={<PlayArrow />} disabled={!draftValid} onClick={() => seek(draftStart, draftEnd)}>
                      Play clip
                    </Button>
                    {canEdit && (
                      <Button
                        variant="contained"
                        startIcon={<Save />}
                        disabled={!dirty || update.isPending}
                        onClick={() => update.mutate({ id: active.id, input: { startSeconds: draftStart, endSeconds: draftEnd } })}
                      >
                        Save trim
                      </Button>
                    )}
                  </Stack>
                  {update.isError && (
                    <Alert severity="error" sx={{ mt: 1.5 }}>
                      {describeError(update.error)}
                    </Alert>
                  )}
                  {active.transcriptExcerpt && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, fontStyle: 'italic' }}>
                      “{active.transcriptExcerpt}”
                    </Typography>
                  )}
                  {activeShort && <PublishPanel clip={activeShort} canEdit={canEdit} />}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                  Pick a highlight from the list to preview and trim it.
                </Typography>
              )}
            </Card>

            <TranscriptPanel
              segments={transcript.data?.segments ?? null}
              meta={transcript.data ? `${transcript.data.segmentCount} lines · ${transcript.data.provider} · ${transcript.data.language}` : null}
              error={transcript.isError ? describeError(transcript.error) : null}
              active={active}
              playhead={playhead}
              onSeek={(t) => seek(t)}
            />
          </Grid>

          <Grid size={{ xs: 12, md: 5 }} sx={{ height: { md: '100%' }, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Card variant="outlined" sx={{ p: 1.5, mb: 1.5, flexShrink: 0 }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                <Movie color="action" />
                <Typography variant="body2" sx={{ flexGrow: 1 }}>
                  {renderingNow || anyRendering ? 'Rendering Shorts…' : `${readyCount} Short${readyCount === 1 ? '' : 's'} ready${needsRender ? ` · ${needsRender} to render` : ''}`}
                </Typography>
                {canEdit && needsRender > 0 && (
                  <Button size="small" variant="contained" disabled={renderingNow || anyRendering || renderJob.isPending} onClick={() => sessionId && renderJob.mutate({ sessionId })}>
                    Render selected
                  </Button>
                )}
                {canEdit && needsRender === 0 && readyCount > 0 && (
                  <Tooltip title="Render every selected clip again, e.g. after changing caption style or reframing in Settings">
                    <span>
                      <Button size="small" variant="outlined" disabled={renderingNow || anyRendering || renderJob.isPending} onClick={() => sessionId && renderJob.mutate({ sessionId, force: true })}>
                        Re-render all
                      </Button>
                    </span>
                  </Tooltip>
                )}
                {canEdit && sessionId && clips.data && clips.data.length > 0 && (
                  <RegenerateShortsButton
                    sessionId={sessionId}
                    currentMode={session.data?.shortStyle ?? settings.data?.clips.shortStyle ?? 'AUTO'}
                    unpublished={clips.data.filter((c) => c.uploadStatus === 'NOT_UPLOADED' && c.instagram.status !== 'PUBLISHED').length}
                    disabled={renderingNow || anyRendering || renderJob.isPending}
                  />
                )}
              </Stack>
              {renderJob.isError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {describeError(renderJob.error)}
                </Alert>
              )}
            </Card>
            <StageBar value={stage} counts={counts} onChange={setStage} busy={{ MAKING: renderingNow || anyRendering }} />
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1.5 }}>
              {stageMeta(stage).hint}
              {canEdit && visible.length > 0 && ' · Keys: J/K move, Enter play, S make Short, X skip'}
            </Typography>
            <Box ref={listRef} sx={{ flex: 1, minHeight: 0, overflowY: { md: 'auto' }, pr: { md: 0.5 }, pb: 2 }}>
            {highlights.isPending ? (
              <Stack spacing={1.5}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} variant="rounded" height={120} />
                ))}
              </Stack>
            ) : highlights.isError ? (
              <Alert severity="error">{describeError(highlights.error)}</Alert>
            ) : visible.length === 0 ? (
              <EmptyStage stage={stage} counts={counts} onGo={setStage} />
            ) : (
              <Stack spacing={1.5}>
                {update.isError && <Alert severity="error">{describeError(update.error)}</Alert>}
                {visible.map((c) => (
                  <Box key={c.id} id={`hl-${c.id}`} sx={{ scrollMarginTop: 80 }}>
                    <CandidateCard
                      c={c}
                      clip={clipByCandidate.get(c.id)}
                      stage={stageById.get(c.id)!}
                      movedTo={stageById.get(c.id) !== stage ? stageById.get(c.id)! : null}
                      active={c.id === activeId}
                      canEdit={canEdit}
                      busy={update.isPending && update.variables?.id === c.id}
                      onOpen={() => {
                        open(c, true);
                        showEditor();
                      }}
                      onStatus={(status) => changeStatus(c, status)}
                      onWatch={() => watch(c)}
                      onGoTo={(st) => {
                        setStage(st);
                        setActiveId(c.id);
                      }}
                    />
                  </Box>
                ))}
              </Stack>
            )}
            </Box>
          </Grid>
        </Grid>
      )}
      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={6000}
        onClose={(_, reason) => reason !== 'clickaway' && setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={toast?.text}
        action={
          toast && (
            <>
              <Button
                size="small"
                color="inherit"
                onClick={() => {
                  const c = items.find((x) => x.id === toast.id);
                  if (c) changeStatus(c, toast.undo, false);
                  setToast(null);
                }}
              >
                Undo
              </Button>
              <Button
                size="small"
                color="primary"
                onClick={() => {
                  setStage(toast.to);
                  setActiveId(toast.id);
                  setToast(null);
                }}
              >
                View
              </Button>
            </>
          )
        }
      />
    </>
  );
}

const CATEGORY_NAMES: Record<string, string> = {
  GAMING: 'Gaming',
  IRL: 'IRL / Reactions',
  PODCAST: 'Podcast / Talk',
  SPORTS: 'Sports',
  COMEDY: 'Comedy',
  MUSIC: 'Music',
  EDUCATION: 'Education',
  OTHER: 'Other',
};

/** The session's category (Phase 10): picks the preset for its next Shorts. */
function CategoryPicker({ sessionId, value, source, canEdit }: { sessionId: string; value: string | null; source: 'detected' | 'manual' | null; canEdit: boolean }) {
  const set = useSetSessionCategory();
  return (
    <Tooltip title={`${source === 'manual' ? 'Set by you' : value ? 'Detected automatically' : 'Detected when highlights are picked'}. Changes apply to Shorts rendered from now on (use Regenerate for existing ones). Presets: Settings → Categories.`}>
      <TextField
        select
        size="small"
        label="Category"
        value={value ?? ''}
        disabled={!canEdit || set.isPending}
        onChange={(e) => set.mutate({ sessionId, category: e.target.value })}
        sx={{ minWidth: 170 }}
        slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
        error={set.isError}
      >
        {!value && (
          <MenuItem value="" disabled>
            Not detected yet
          </MenuItem>
        )}
        {Object.entries(CATEGORY_NAMES).map(([k, l]) => (
          <MenuItem key={k} value={k}>
            {l}
          </MenuItem>
        ))}
      </TextField>
    </Tooltip>
  );
}

/** Empty stage: say what goes here and point to where the work is. */
function EmptyStage({ stage, counts, onGo }: { stage: Stage; counts: Record<Stage, number>; onGo: (s: Stage) => void }) {
  const next = STAGES.find((x) => x.id !== stage && counts[x.id] > 0);
  const text: Record<Stage, string> = {
    REVIEW: 'All AI picks are reviewed.',
    MAKING: 'Nothing waiting to be rendered.',
    READY: 'No rendered Shorts waiting. Select highlights and render them.',
    PUBLISHED: 'Nothing published from this session yet.',
    DISCARDED: 'Nothing discarded.',
  };
  return (
    <Card variant="outlined" sx={{ p: 3, textAlign: 'center', borderStyle: 'dashed' }}>
      <Typography variant="body2" color="text.secondary">
        {text[stage]}
      </Typography>
      {next && (
        <Button size="small" sx={{ mt: 1 }} onClick={() => onGo(next.id)}>
          Go to {next.label} ({counts[next.id]})
        </Button>
      )}
    </Card>
  );
}

function TranscriptPanel({
  segments,
  meta,
  error,
  active,
  playhead,
  onSeek,
}: {
  segments: TranscriptSegmentDTO[] | null;
  meta: string | null;
  error: string | null;
  active: HighlightCandidateDTO | null;
  playhead: number;
  onSeek: (t: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [onlyClip, setOnlyClip] = useState(true);
  // Phones: folded by default so the highlight list isn't pushed far down.
  const [shown, setShown] = useState(() => !window.matchMedia('(max-width: 899.95px)').matches);
  const q = query.trim().toLowerCase();
  const rows = (segments ?? []).filter((s) => {
    if (q) return s.text.toLowerCase().includes(q);
    if (onlyClip && active) return s.endSeconds > active.startSeconds - 10 && s.startSeconds < active.endSeconds + 10;
    return true;
  });

  return (
    <Card variant="outlined" sx={{ p: 1.5, mt: 2 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' }, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Transcript {meta && <Typography component="span" variant="caption" color="text.secondary">· {meta}</Typography>}
        </Typography>
        <Button size="small" onClick={() => setShown((v) => !v)} sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}>
          {shown ? 'Hide' : 'Show'}
        </Button>
        {shown && active && !q && <FormControlLabel control={<Switch size="small" checked={onlyClip} onChange={(e) => setOnlyClip(e.target.checked)} />} label={<Typography variant="body2">Around this clip</Typography>} />}
        {shown && <TextField
          size="small"
          placeholder="Search transcript"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> } }}
        />}
      </Stack>
      {!shown ? null : error ? (
        <Typography variant="body2" color="text.secondary">
          {error}
        </Typography>
      ) : !segments ? (
        <Skeleton variant="rounded" height={160} />
      ) : (
        <Box sx={{ maxHeight: 320, overflowY: 'auto' }}>
          {rows.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No matching lines.
            </Typography>
          )}
          {rows.slice(0, 500).map((s) => {
            const inClip = active && s.endSeconds > active.startSeconds && s.startSeconds < active.endSeconds;
            const now = playhead >= s.startSeconds && playhead < s.endSeconds;
            return (
              <Stack
                key={s.startSeconds}
                direction="row"
                spacing={1.5}
                onClick={() => onSeek(s.startSeconds)}
                sx={{
                  px: 1,
                  py: 0.5,
                  cursor: 'pointer',
                  borderRadius: 1,
                  bgcolor: now ? 'action.selected' : inClip ? 'action.hover' : undefined,
                  '&:hover': { bgcolor: 'action.focus' },
                }}
              >
                <Typography variant="caption" color="primary" sx={{ fontFamily: 'monospace', pt: '2px', minWidth: 52 }}>
                  {formatClock(s.startSeconds)}
                </Typography>
                <Typography variant="body2">{s.text}</Typography>
              </Stack>
            );
          })}
        </Box>
      )}
    </Card>
  );
}

/** Vertical player for a rendered Short, with download. */
function ShortPlayer({ clip }: { clip: GeneratedClipDTO }) {
  const media = useClipMedia(clip.id, clip.renderVersion);
  return (
    <Stack spacing={1} sx={{ alignItems: 'center' }}>
      <Box sx={{ bgcolor: 'common.black', borderRadius: 2, overflow: 'hidden', height: { xs: '68vh', md: 'min(600px, calc(100vh - 230px))' }, aspectRatio: '9 / 16', maxWidth: '100%' }}>
        {media.data ? (
          <video key={media.data.videoUrl} src={media.data.videoUrl} poster={media.data.thumbnailUrl ?? undefined} controls autoPlay style={{ width: '100%', height: '100%', display: 'block' }} />
        ) : media.isError ? (
          <Typography color="grey.400" variant="body2" sx={{ p: 2 }}>
            {describeError(media.error)}
          </Typography>
        ) : (
          <Skeleton variant="rectangular" sx={{ height: '100%', bgcolor: 'grey.900' }} />
        )}
      </Box>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          {clip.width}×{clip.height} · {Math.round(clip.durationSeconds)}s · {formatBytes(clip.fileSizeBytes)} · v{clip.renderVersion}
        </Typography>
        {clip.shortStyle && (
          <Tooltip title={clip.styleReason ? `Why: ${clip.styleReason}` : ''}>
            <Chip size="small" variant="outlined" label={STYLE_NAMES[clip.shortStyle] ?? clip.shortStyle} />
          </Tooltip>
        )}
        {media.data && (
          <Button size="small" startIcon={<Download />} href={media.data.videoUrl} download={`short-${clip.id}.mp4`} target="_blank" rel="noopener noreferrer">
            Download
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
