import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
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
import { useClipMedia, useClips, useHighlights, useMe, useRenderSession, useSession, useSessions, useSetFacecam, useSettings, useSourcePreview, useTranscript, useUpdateHighlight } from '../api/hooks';
import { FacecamOverlay } from '../components/FacecamOverlay';
import { CandidateCard, type RenderState } from '../components/CandidateCard';
import { PageHeader } from '../components/PageHeader';
import { PublishPanel } from '../components/PublishPanel';
import { StatusChip } from '../components/StatusChip';
import { formatBytes, formatClock, formatDateTime, formatUsd } from '../lib/format';

type Filter = 'SELECTED' | 'CANDIDATE' | 'DISCARDED' | 'ALL';

function renderStateOf(c: HighlightCandidateDTO, clip: GeneratedClipDTO | undefined): RenderState | null {
  if (!clip) return c.status === 'SELECTED' ? 'NOT_RENDERED' : null;
  if (clip.uploadStatus === 'PUBLISHED') return 'PUBLISHED';
  if (clip.uploadStatus === 'QUEUED' || clip.uploadStatus === 'UPLOADING') return 'UPLOADING';
  if (clip.renderStatus === 'RENDERING' || clip.renderStatus === 'PENDING') return 'RENDERING';
  if (clip.renderStatus === 'RENDER_FAILED') return 'RENDER_FAILED';
  const moved = Math.abs(clip.startSeconds - c.startSeconds) > 0.05 || Math.abs(clip.endSeconds - c.endSeconds) > 0.05;
  return moved ? 'OUTDATED' : 'RENDERED';
}

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

  const [filter, setFilter] = useState<Filter>('SELECTED');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [showFrame, setShowFrame] = useState(true);
  const [editFacecam, setEditFacecam] = useState(false);
  const settings = useSettings();
  const setFacecam = useSetFacecam();
  const splitLayout = settings.data?.clips.reframingMode === 'FACECAM_SPLIT';
  const [playhead, setPlayhead] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);

  // Default to the most recent analysed session.
  useEffect(() => {
    const first = sessions.data?.items[0];
    if (!sessionId && first) setParams({ session: first.id }, { replace: true });
  }, [sessionId, sessions.data, setParams]);

  const items = highlights.data ?? [];
  const counts = useMemo(
    () => ({
      SELECTED: items.filter((c) => c.status === 'SELECTED').length,
      CANDIDATE: items.filter((c) => c.status === 'CANDIDATE').length,
      DISCARDED: items.filter((c) => c.status === 'DISCARDED').length,
      ALL: items.length,
    }),
    [items],
  );
  const visible = filter === 'ALL' ? items : items.filter((c) => c.status === filter);
  const active = items.find((c) => c.id === activeId) ?? null;
  const renderingNow = session.data?.processingStage === 'RENDERING';
  const clips = useClips(sessionId, renderingNow);
  const clipByCandidate = useMemo(() => new Map((clips.data ?? []).map((c) => [c.highlightCandidateId, c])), [clips.data]);
  const anyRendering = (clips.data ?? []).some((c) => c.renderStatus === 'RENDERING');
  const activeClip = active ? clipByCandidate.get(active.id) : undefined;
  const activeShort = activeClip?.renderStatus === 'RENDERED' ? activeClip : undefined;
  const needsRender = items.filter((c) => c.status === 'SELECTED' && ['NOT_RENDERED', 'OUTDATED', 'RENDER_FAILED'].includes(renderStateOf(c, clipByCandidate.get(c.id)) ?? '')).length;
  const readyCount = (clips.data ?? []).filter((c) => c.renderStatus === 'RENDERED').length;

  // When the selected tab is empty after loading, fall back to all.
  useEffect(() => {
    if (highlights.isSuccess && filter !== 'ALL' && counts[filter] === 0 && counts.ALL > 0) setFilter('ALL');
  }, [highlights.isSuccess, counts, filter]);

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
          sx={{ minWidth: 320, maxWidth: '100%' }}
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
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 7 }}>
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
                  Pick a highlight on the right to preview and trim it.
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

          <Grid size={{ xs: 12, md: 5 }}>
            <Card variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
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
              </Stack>
              {renderJob.isError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {describeError(renderJob.error)}
                </Alert>
              )}
            </Card>
            <Tabs value={filter} onChange={(_, v: Filter) => setFilter(v)} variant="scrollable" sx={{ mb: 1.5, minHeight: 40 }}>
              <Tab value="SELECTED" label={`Selected (${counts.SELECTED})`} sx={{ minHeight: 40 }} />
              <Tab value="CANDIDATE" label={`Candidates (${counts.CANDIDATE})`} sx={{ minHeight: 40 }} />
              <Tab value="DISCARDED" label={`Discarded (${counts.DISCARDED})`} sx={{ minHeight: 40 }} />
              <Tab value="ALL" label={`All (${counts.ALL})`} sx={{ minHeight: 40 }} />
            </Tabs>
            {highlights.isPending ? (
              <Stack spacing={1.5}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} variant="rounded" height={120} />
                ))}
              </Stack>
            ) : highlights.isError ? (
              <Alert severity="error">{describeError(highlights.error)}</Alert>
            ) : visible.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nothing here.
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {visible.map((c) => (
                  <CandidateCard
                    key={c.id}
                    c={c}
                    active={c.id === activeId}
                    canEdit={canEdit}
                    busy={update.isPending}
                    renderState={renderStateOf(c, clipByCandidate.get(c.id))}
                    renderError={clipByCandidate.get(c.id)?.lastError}
                    onOpen={() => open(c, true)}
                    onStatus={(status) => update.mutate({ id: c.id, input: { status } })}
                  />
                ))}
              </Stack>
            )}
          </Grid>
        </Grid>
      )}
    </>
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
        {active && !q && <FormControlLabel control={<Switch size="small" checked={onlyClip} onChange={(e) => setOnlyClip(e.target.checked)} />} label={<Typography variant="body2">Around this clip</Typography>} />}
        <TextField
          size="small"
          placeholder="Search transcript"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> } }}
        />
      </Stack>
      {error ? (
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
      <Box sx={{ bgcolor: 'common.black', borderRadius: 2, overflow: 'hidden', height: { xs: 520, md: 600 }, aspectRatio: '9 / 16', maxWidth: '100%' }}>
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
        {media.data && (
          <Button size="small" startIcon={<Download />} href={media.data.videoUrl} download={`short-${clip.id}.mp4`} target="_blank" rel="noopener noreferrer">
            Download
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
