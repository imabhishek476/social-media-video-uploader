import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckCircle from '@mui/icons-material/CheckCircle';
import DoNotDisturb from '@mui/icons-material/DoNotDisturb';
import Edit from '@mui/icons-material/Edit';
import type { HighlightCandidateDTO } from '@shorts/shared-types';
import { formatClock, humanize } from '../lib/format';
import { StatusChip } from './StatusChip';

const BREAKDOWN_ORDER = ['hook', 'emotion', 'entertainment', 'payoff', 'context', 'clarity', 'audio'];

export type RenderState = 'RENDERED' | 'RENDERING' | 'RENDER_FAILED' | 'OUTDATED' | 'NOT_RENDERED' | 'UPLOADING' | 'PUBLISHED';

const RENDER_CHIP: Record<RenderState, { label: string; color: 'success' | 'info' | 'error' | 'warning' | 'default' }> = {
  RENDERED: { label: 'Short ready', color: 'success' },
  RENDERING: { label: 'Rendering…', color: 'info' },
  RENDER_FAILED: { label: 'Render failed', color: 'error' },
  OUTDATED: { label: 'Needs re-render', color: 'warning' },
  NOT_RENDERED: { label: 'Not rendered', color: 'default' },
  UPLOADING: { label: 'Uploading…', color: 'info' },
  PUBLISHED: { label: 'Published', color: 'success' },
};

export function scoreColor(score: number): 'success' | 'warning' | 'default' {
  return score >= 80 ? 'success' : score >= 60 ? 'warning' : 'default';
}

/** One highlight candidate in the Clip Studio list. */
export function CandidateCard({
  c,
  active,
  canEdit,
  busy,
  renderState,
  renderError,
  onOpen,
  onStatus,
}: {
  renderState: RenderState | null;
  renderError?: string | null;
  c: HighlightCandidateDTO;
  active: boolean;
  canEdit: boolean;
  busy: boolean;
  onOpen: () => void;
  onStatus: (status: 'SELECTED' | 'DISCARDED' | 'CANDIDATE') => void;
}) {
  const breakdown = BREAKDOWN_ORDER.filter((k) => typeof c.scoreBreakdown[k] === 'number');
  return (
    <Card variant="outlined" sx={{ borderColor: active ? 'primary.main' : undefined, borderWidth: active ? 2 : 1, opacity: c.status === 'DISCARDED' ? 0.7 : 1 }}>
      <CardActionArea onClick={onOpen} sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75, flexWrap: 'wrap', rowGap: 0.5 }}>
          <Chip label={c.score} color={scoreColor(c.score)} size="small" sx={{ fontWeight: 700, minWidth: 40 }} />
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {formatClock(c.startSeconds)}–{formatClock(c.endSeconds)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {Math.round(c.durationSeconds)}s
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          {c.userAdjusted && (
            <Tooltip title="Edited in Clip Studio; kept when the session is re-analysed">
              <Edit fontSize="small" color="action" />
            </Tooltip>
          )}
          <StatusChip status={c.status} />
        </Stack>
        {renderState && (
          <Tooltip title={renderError ?? ''}>
            <Chip size="small" label={RENDER_CHIP[renderState].label} color={RENDER_CHIP[renderState].color} sx={{ mb: 0.75 }} />
          </Tooltip>
        )}
        {c.hook && (
          <Typography variant="subtitle2" sx={{ lineHeight: 1.35 }}>
            {c.hook}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {c.reason}
        </Typography>
        {c.topic && <Chip label={c.topic} size="small" variant="outlined" sx={{ mt: 1 }} />}
        {c.discardReason && c.status === 'DISCARDED' && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
            {c.discardReason}
          </Typography>
        )}
        {active && breakdown.length > 0 && (
          <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: 'auto 1fr 28px', columnGap: 1, rowGap: 0.5, alignItems: 'center' }}>
            {breakdown.map((k) => (
              <Box key={k} sx={{ display: 'contents' }}>
                <Typography variant="caption" color="text.secondary">
                  {humanize(k)}
                </Typography>
                <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, c.scoreBreakdown[k]!))} sx={{ height: 6, borderRadius: 3 }} />
                <Typography variant="caption" sx={{ textAlign: 'right' }}>
                  {Math.round(c.scoreBreakdown[k]!)}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </CardActionArea>
      {canEdit && (
        <Stack direction="row" spacing={1} sx={{ px: 1.5, pb: 1.5 }}>
          {c.status !== 'SELECTED' && (
            <Button size="small" variant="outlined" color="success" startIcon={<CheckCircle />} disabled={busy} onClick={() => onStatus('SELECTED')}>
              Select
            </Button>
          )}
          {c.status !== 'DISCARDED' ? (
            <Button size="small" color="inherit" startIcon={<DoNotDisturb />} disabled={busy} onClick={() => onStatus('DISCARDED')}>
              Discard
            </Button>
          ) : (
            <Button size="small" color="inherit" disabled={busy} onClick={() => onStatus('CANDIDATE')}>
              Restore
            </Button>
          )}
        </Stack>
      )}
    </Card>
  );
}
