import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Close from '@mui/icons-material/Close';
import OpenInNew from '@mui/icons-material/OpenInNew';
import Replay from '@mui/icons-material/Replay';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { describeError } from '../api/client';
import { useReprocessSession, useSession, useUploadSource } from '../api/hooks';
import { formatBytes, formatDateTime, formatDuration, formatUsd, humanize } from '../lib/format';
import ContentCut from '@mui/icons-material/ContentCut';
import { useRef, useState } from 'react';
import LinearProgress from '@mui/material/LinearProgress';
import UploadFile from '@mui/icons-material/UploadFile';
import Tooltip from '@mui/material/Tooltip';
import { StatusChip } from './StatusChip';

const END_REASONS: Record<string, string> = {
  PROVIDER_END_TIME: 'YouTube reported the stream end time',
  NOT_LIVE_CONFIRMED: 'Confirmed not live over several consecutive checks',
  UNAVAILABLE_CONFIRMED: 'Broadcast became unavailable (private/deleted) and stayed so',
  MISSED_LIVE: 'Started and ended between two checks',
  IMPORTED: 'Added by hand from a YouTube URL',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 0.75, justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Stack>
  );
}

/** Detail panel for one live session, including pipeline state and errors. */
export function SessionDrawer({ sessionId, canEdit, onClose }: { sessionId: string | null; canEdit: boolean; onClose: () => void }) {
  const { data: s, isPending } = useSession(sessionId);
  const reprocess = useReprocessSession();
  const upload = useUploadSource();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const live = s?.status === 'LIVE' || s?.status === 'DETECTED';
  const busy = s?.processingStatus === 'QUEUED' || s?.processingStatus === 'RUNNING';

  return (
    <Drawer anchor="right" open={Boolean(sessionId)} onClose={onClose} slotProps={{ paper: { sx: { width: { xs: '100%', sm: 440 } } } }}>
      <Stack direction="row" sx={{ alignItems: 'center', px: 2, py: 1.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Live session
        </Typography>
        <IconButton onClick={onClose} aria-label="Close">
          <Close />
        </IconButton>
      </Stack>
      <Divider />
      <Box sx={{ p: 2, overflowY: 'auto' }}>
        {isPending || !s ? (
          <Skeleton variant="rounded" height={300} />
        ) : (
          <>
            <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
              {s.title || 'Untitled broadcast'}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ my: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
              <StatusChip status={s.status} size="medium" />
              <Button size="small" component={RouterLink} to={`/streamers/${s.streamer.id}`} onClick={onClose}>
                {s.streamer.displayName}
              </Button>
              <Button size="small" href={s.videoUrl} target="_blank" rel="noopener noreferrer" endIcon={<OpenInNew fontSize="small" />}>
                YouTube
              </Button>
            </Stack>

            {s.lastError && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {s.lastError}
              </Alert>
            )}

            <Typography variant="overline" color="text.secondary">
              Lifecycle
            </Typography>
            <Row label="Broadcast ID">
              <Link href={s.videoUrl} target="_blank" rel="noopener noreferrer" sx={{ fontFamily: 'monospace' }}>
                {s.broadcastId}
              </Link>
            </Row>
            <Row label="Started">{formatDateTime(s.startedAt)}</Row>
            <Row label="Ended">{live ? 'Still live' : formatDateTime(s.endedAt)}</Row>
            <Row label="Duration">{formatDuration(s.durationSeconds)}</Row>
            {live && <Row label="Last seen live">{formatDateTime(s.lastObservedLiveAt)}</Row>}
            {live && s.endConfirmationCount > 0 && <Row label="End confirmations">{s.endConfirmationCount} (not live yet)</Row>}
            {s.endReason && <Row label="End detected by">{END_REASONS[s.endReason] ?? humanize(s.endReason)}</Row>}

            <Divider sx={{ my: 1.5 }} />
            <Typography variant="overline" color="text.secondary">
              Pipeline
            </Typography>
            <Row label="Source media">
              <StatusChip status={s.sourceMedia.status} />
            </Row>
            {s.sourceMedia.lastError && <Row label="Source error">{s.sourceMedia.lastError}</Row>}
            {s.sourceMedia.status === 'READY' && (
              <>
                <Row label="Recording">
                  {s.sourceMedia.width}×{s.sourceMedia.height} {s.sourceMedia.videoCodec?.toUpperCase()} · {formatDuration(s.sourceMedia.durationSeconds)} · {formatBytes(s.sourceMedia.fileSizeBytes)}
                </Row>
                <Row label="Stored in">{s.sourceMedia.storedIn === 'gcs' ? 'Google Cloud Storage' : 'Local disk'}</Row>
              </>
            )}
            <Row label="Processing">
              <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                {s.processingStage && <StatusChip status={s.processingStage} />}
                <StatusChip status={s.processingStatus} />
              </Stack>
            </Row>
            <Row label="Highlights">{s.highlightCount}</Row>
            <Row label="Clips generated">{s.clipCount}</Row>
            <Row label="AI cost (est.)">{formatUsd(s.estimatedCostUsd)}</Row>
            <Row label="Reprocess rounds">{s.reprocessCount}</Row>

            {s.status === 'SOURCE_UNAVAILABLE' && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                {s.sourceMedia.lastError ?? 'No usable recording yet.'}
              </Alert>
            )}
            {s.status === 'SOURCE_READY' && (
              <Alert severity="success" variant="outlined" sx={{ mt: 2 }}>
                Recording stored and validated. Transcription and highlight analysis start next.
              </Alert>
            )}
            {s.status === 'HIGHLIGHTS_READY' && (
              <Button sx={{ mt: 2, mr: 1 }} variant="contained" startIcon={<ContentCut />} component={RouterLink} to={`/clips?session=${s.id}`} onClick={onClose}>
                Open in Clip Studio
              </Button>
            )}
            {canEdit && !live && s.sourceMedia.status !== 'READY' && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept="video/*,.mkv,.ts,.flv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) {
                      setProgress(0);
                      upload.mutate({ id: s.id, file, onProgress: setProgress });
                    }
                  }}
                />
                <Button sx={{ mt: 2, mr: 1 }} variant="contained" startIcon={<UploadFile />} disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
                  {upload.isPending ? `Uploading… ${progress}%` : 'Upload recording'}
                </Button>
                {upload.isPending && <LinearProgress variant="determinate" value={progress} sx={{ mt: 1 }} />}
                {upload.isError && (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    {describeError(upload.error)}
                  </Alert>
                )}
              </>
            )}

            {canEdit && (
              <>
                {reprocess.isError && (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    {describeError(reprocess.error)}
                  </Alert>
                )}
                <Button
                  sx={{ mt: 2 }}
                  variant="outlined"
                  startIcon={<Replay />}
                  disabled={live || busy || reprocess.isPending || upload.isPending}
                  onClick={() => reprocess.mutate(s.id)}
                >
                  Reprocess
                </Button>
                {s.sourceMedia.status === 'READY' && (
                  <Tooltip title="Transcribe the recording again (exact word timing for captions), then re-analyse. Uses transcription quota.">
                    <span>
                      <Button sx={{ mt: 2, ml: 1 }} disabled={live || busy || reprocess.isPending} onClick={() => reprocess.mutate({ id: s.id, retranscribe: true })}>
                        Re-transcribe
                      </Button>
                    </span>
                  </Tooltip>
                )}
                {(live || busy) && (
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                    {live ? 'Available after the stream ends.' : 'Processing is already queued or running.'}
                  </Typography>
                )}
              </>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}
