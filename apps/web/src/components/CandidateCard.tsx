import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import ArrowForward from '@mui/icons-material/ArrowForward';
import CheckCircle from '@mui/icons-material/CheckCircle';
import DoNotDisturb from '@mui/icons-material/DoNotDisturb';
import Edit from '@mui/icons-material/Edit';
import Instagram from '@mui/icons-material/Instagram';
import PlayArrow from '@mui/icons-material/PlayArrow';
import Undo from '@mui/icons-material/Undo';
import YouTube from '@mui/icons-material/YouTube';
import type { GeneratedClipDTO, HighlightCandidateDTO } from '@shorts/shared-types';
import { formatClock, humanize } from '../lib/format';
import { stageMeta, type Stage } from './StagePipeline';

const BREAKDOWN_ORDER = ['hook', 'emotion', 'entertainment', 'payoff', 'context', 'clarity', 'audio', 'chat'];

export function scoreColor(score: number): 'success' | 'warning' | 'default' {
  return score >= 80 ? 'success' : score >= 60 ? 'warning' : 'default';
}

/** What is happening to a selected highlight right now. */
function makingState(c: HighlightCandidateDTO, clip: GeneratedClipDTO | undefined): { label: string; color: 'info' | 'warning' | 'error' | 'default'; spinning?: boolean } {
  if (!clip) return { label: 'Waiting to render', color: 'default' };
  if (clip.renderStatus === 'RENDERING' || clip.renderStatus === 'PENDING') return { label: 'Rendering…', color: 'info', spinning: true };
  if (clip.renderStatus === 'RENDER_FAILED') return { label: 'Render failed', color: 'error' };
  const moved = Math.abs(clip.startSeconds - c.startSeconds) > 0.05 || Math.abs(clip.endSeconds - c.endSeconds) > 0.05;
  return moved ? { label: 'Trimmed · needs re-render', color: 'warning' } : { label: 'Waiting to render', color: 'default' };
}

const STYLE_NAMES: Record<string, string> = { REACTION: 'Reaction', GAMEPLAY: 'Gameplay', CLEAN: 'Clean gameplay', STORY: 'Story' };

function ScoreRing({ score }: { score: number }) {
  const color = scoreColor(score);
  return (
    <Tooltip title="AI score: how likely this moment works as a Short">
      <Box sx={{ position: 'relative', width: 44, height: 44, flexShrink: 0 }}>
        <CircularProgress variant="determinate" value={100} size={44} thickness={4} sx={{ color: 'action.hover', position: 'absolute' }} />
        <CircularProgress variant="determinate" value={score} size={44} thickness={4} color={color === 'default' ? 'inherit' : color} sx={{ position: 'absolute', color: color === 'default' ? 'text.disabled' : undefined }} />
        <Typography sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14 }}>{score}</Typography>
      </Box>
    </Tooltip>
  );
}

/** One highlight in the Clip Studio list, with the actions that fit its stage. */
export function CandidateCard({
  c,
  clip,
  stage,
  movedTo,
  active,
  canEdit,
  busy,
  onOpen,
  onStatus,
  onWatch,
  onGoTo,
}: {
  c: HighlightCandidateDTO;
  clip: GeneratedClipDTO | undefined;
  stage: Stage;
  /** Set when the card just moved to another stage and is kept here so it doesn't vanish. */
  movedTo: Stage | null;
  active: boolean;
  canEdit: boolean;
  busy: boolean;
  onOpen: () => void;
  onStatus: (status: 'SELECTED' | 'DISCARDED' | 'CANDIDATE') => void;
  onWatch: () => void;
  onGoTo: (s: Stage) => void;
}) {
  const breakdown = BREAKDOWN_ORDER.filter((k) => typeof c.scoreBreakdown[k] === 'number');
  const making = stage === 'MAKING' ? makingState(c, clip) : null;
  const ig = clip?.instagram;
  return (
    <Card
      variant="outlined"
      sx={(t) => ({
        borderColor: active ? 'primary.main' : 'divider',
        boxShadow: active ? `0 0 0 1px ${t.palette.primary.main}, 0 6px 20px ${alpha(t.palette.primary.main, 0.18)}` : 'none',
        opacity: stage === 'DISCARDED' || movedTo ? 0.78 : 1,
        transition: 'box-shadow .2s, border-color .2s, opacity .2s, transform .2s',
        '&:hover': { transform: 'translateY(-1px)', borderColor: active ? 'primary.main' : 'text.disabled' },
      })}
    >
      {movedTo && (
        <ButtonRow onClick={() => onGoTo(movedTo)} label={`Moved to ${stageMeta(movedTo).label}`} />
      )}
      <CardActionArea onClick={onOpen} sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <ScoreRing score={c.score} />
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography variant="subtitle2" sx={{ lineHeight: 1.3, fontWeight: 700 }}>
              {c.hook || c.topic || 'Highlight'}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25, flexWrap: 'wrap', rowGap: 0.5 }}>
              <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color="text.secondary">
                {formatClock(c.startSeconds)}–{formatClock(c.endSeconds)} · {Math.round(c.durationSeconds)}s
              </Typography>
              {c.userAdjusted && (
                <Tooltip title="You trimmed this; kept when the session is re-analysed">
                  <Edit sx={{ fontSize: 14 }} color="action" />
                </Tooltip>
              )}
              {clip?.shortStyle && stage !== 'REVIEW' && (
                <Tooltip title={clip.styleReason ? `Why: ${clip.styleReason}` : ''}>
                  <Chip size="small" variant="outlined" label={STYLE_NAMES[clip.shortStyle] ?? clip.shortStyle} sx={{ height: 20, fontSize: 11 }} />
                </Tooltip>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, display: '-webkit-box', WebkitLineClamp: active ? 'unset' : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {c.reason}
            </Typography>
            {making && (
              <Tooltip title={clip?.lastError ?? ''}>
                <Chip
                  size="small"
                  color={making.color}
                  icon={making.spinning ? <CircularProgress size={12} color="inherit" /> : undefined}
                  label={making.label}
                  sx={{ mt: 1 }}
                />
              </Tooltip>
            )}
            {c.discardReason && stage === 'DISCARDED' && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                {c.discardReason}
              </Typography>
            )}
          </Box>
        </Stack>
        <Collapse in={active && breakdown.length > 0} unmountOnExit>
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
        </Collapse>
      </CardActionArea>

      <Stack direction="row" spacing={1} sx={{ px: 1.5, pb: 1.25, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        {stage === 'REVIEW' && canEdit && (
          <>
            <Button size="small" variant="contained" color="success" startIcon={<CheckCircle />} disabled={busy} onClick={() => onStatus('SELECTED')}>
              Make Short
            </Button>
            <Button size="small" color="inherit" startIcon={<DoNotDisturb />} disabled={busy} onClick={() => onStatus('DISCARDED')}>
              Skip
            </Button>
          </>
        )}
        {(stage === 'MAKING' || stage === 'READY') && (
          <>
            {stage === 'READY' && (
              <Button size="small" variant="contained" startIcon={<PlayArrow />} onClick={onWatch}>
                Watch & publish
              </Button>
            )}
            {canEdit && (
              <Button size="small" color="inherit" startIcon={<Undo />} disabled={busy} onClick={() => onStatus('CANDIDATE')}>
                Back to review
              </Button>
            )}
          </>
        )}
        {stage === 'PUBLISHED' && (
          <>
            {clip?.youtubeUrl && (
              <Button size="small" startIcon={<YouTube />} href={clip.youtubeUrl} target="_blank" rel="noreferrer">
                {clip.uploadStatus === 'PUBLISHED' ? 'YouTube' : humanize(clip.uploadStatus)}
              </Button>
            )}
            {ig?.permalink && (
              <Button size="small" startIcon={<Instagram />} href={ig.permalink} target="_blank" rel="noreferrer">
                Instagram
              </Button>
            )}
            {!clip?.youtubeUrl && <Chip size="small" label={humanize(clip?.uploadStatus ?? '')} />}
            <Button size="small" color="inherit" onClick={onWatch}>
              Details
            </Button>
          </>
        )}
        {stage === 'DISCARDED' && canEdit && (
          <Button size="small" variant="outlined" startIcon={<Undo />} disabled={busy} onClick={() => onStatus('CANDIDATE')}>
            Restore
          </Button>
        )}
      </Stack>
    </Card>
  );
}

function ButtonRow({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <CardActionArea onClick={onClick} sx={{ px: 1.5, py: 0.5, bgcolor: 'action.selected' }}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" sx={{ fontWeight: 600, flexGrow: 1 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="primary">
          View
        </Typography>
        <ArrowForward sx={{ fontSize: 14 }} color="primary" />
      </Stack>
    </CardActionArea>
  );
}
