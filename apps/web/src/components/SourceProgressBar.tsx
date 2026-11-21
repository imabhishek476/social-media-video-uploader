import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import type { LiveSessionDTO } from '@shorts/shared-types';
import { formatBytes } from '../lib/format';

const eta = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)}s`);

/** Download / store progress for a session's recording. `compact` = table cell. */
export function SourceProgressBar({ progress, compact = false }: { progress: LiveSessionDTO['sourceMedia']['progress']; compact?: boolean }) {
  if (!progress) return null;
  const pct = progress.percent;
  const storing = progress.phase === 'STORING';
  const finishing = !storing && pct !== null && pct >= 99;
  const label = storing
    ? `Saving to storage${progress.totalBytes ? ` (${formatBytes(progress.totalBytes)})` : ''}…`
    : finishing
      ? 'Joining video and audio…'
      : [
          pct !== null ? `${Math.floor(pct)}%` : 'Downloading',
          progress.downloadedBytes !== null ? `${formatBytes(progress.downloadedBytes)}${progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ''}` : null,
          progress.speedBytesPerSec ? `${formatBytes(progress.speedBytesPerSec)}/s` : null,
          progress.etaSeconds ? `${eta(progress.etaSeconds)} left` : null,
        ]
          .filter(Boolean)
          .join(' · ');
  const indeterminate = storing || finishing || pct === null;
  return (
    <Box sx={{ minWidth: compact ? 120 : undefined, mt: compact ? 0.5 : 1 }}>
      <LinearProgress variant={indeterminate ? 'indeterminate' : 'determinate'} value={pct ?? 0} sx={{ height: compact ? 4 : 6, borderRadius: 3 }} />
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25, whiteSpace: compact ? 'nowrap' : undefined }}>
        {compact && !storing && !finishing && pct !== null ? `${Math.floor(pct)}%${progress.etaSeconds ? ` · ${eta(progress.etaSeconds)}` : ''}` : label}
      </Typography>
    </Box>
  );
}
