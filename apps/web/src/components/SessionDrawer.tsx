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
import { useReprocessSession, useSession } from '../api/hooks';
import { formatDateTime, formatDuration, humanize } from '../lib/format';
import { StatusChip } from './StatusChip';

const END_REASONS: Record<string, string> = {
  PROVIDER_END_TIME: 'YouTube reported the stream end time',
  NOT_LIVE_CONFIRMED: 'Confirmed not live over several consecutive checks',
  UNAVAILABLE_CONFIRMED: 'Broadcast became unavailable (private/deleted) and stayed so',
  MISSED_LIVE: 'Started and ended between two checks',
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
            <Row label="Processing">
              <StatusChip status={s.processingStatus} />
            </Row>
            <Row label="Clips generated">{s.clipCount}</Row>
            <Row label="Reprocess rounds">{s.reprocessCount}</Row>

            {s.processingStatus === 'QUEUED' && (
              <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
                Waiting for media acquisition. The worker for that step arrives in Phase 3, so the job stays queued until then.
              </Alert>
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
                  disabled={live || busy || reprocess.isPending}
                  onClick={() => reprocess.mutate(s.id)}
                >
                  Reprocess
                </Button>
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
