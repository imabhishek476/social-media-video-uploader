import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { alpha, useTheme } from '@mui/material/styles';
import ChevronRight from '@mui/icons-material/ChevronRight';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import FactCheckOutlined from '@mui/icons-material/FactCheckOutlined';
import MovieFilterOutlined from '@mui/icons-material/MovieFilterOutlined';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import RocketLaunchOutlined from '@mui/icons-material/RocketLaunchOutlined';
import type { GeneratedClipDTO, HighlightCandidateDTO } from '@shorts/shared-types';

/**
 * Where a highlight is on its way to becoming a published Short. One place per
 * highlight, in the order the work happens.
 */
export type Stage = 'REVIEW' | 'MAKING' | 'READY' | 'PUBLISHED' | 'DISCARDED';

export const STAGES: Array<{ id: Stage; label: string; hint: string; icon: typeof FactCheckOutlined; color: 'info' | 'warning' | 'success' | 'primary' | 'grey' }> = [
  { id: 'REVIEW', label: 'Review', hint: 'AI picks waiting for your yes or no', icon: FactCheckOutlined, color: 'info' },
  { id: 'MAKING', label: 'Selected', hint: 'Chosen; being made into Shorts', icon: MovieFilterOutlined, color: 'warning' },
  { id: 'READY', label: 'Ready', hint: 'Rendered Shorts to watch and publish', icon: PlayCircleOutline, color: 'success' },
  { id: 'PUBLISHED', label: 'Published', hint: 'Live (or scheduled) on YouTube / Instagram', icon: RocketLaunchOutlined, color: 'primary' },
];
export const DISCARDED_STAGE = { id: 'DISCARDED' as const, label: 'Discarded', hint: 'Left out; restore any time', icon: DeleteOutline, color: 'grey' as const };
export const stageMeta = (s: Stage) => STAGES.find((x) => x.id === s) ?? DISCARDED_STAGE;

export function stageOf(c: HighlightCandidateDTO, clip: GeneratedClipDTO | undefined): Stage {
  if (clip && (clip.uploadStatus !== 'NOT_UPLOADED' || clip.instagram.status === 'PUBLISHED')) return 'PUBLISHED';
  if (c.status === 'DISCARDED') return 'DISCARDED';
  if (c.status === 'CANDIDATE') return 'REVIEW';
  const moved = clip && (Math.abs(clip.startSeconds - c.startSeconds) > 0.05 || Math.abs(clip.endSeconds - c.endSeconds) > 0.05);
  return clip?.renderStatus === 'RENDERED' && !moved ? 'READY' : 'MAKING';
}

/** The pipeline across the top of the list: each step is a filter with its count. */
export function StageBar({ value, counts, onChange, busy }: { value: Stage; counts: Record<Stage, number>; onChange: (s: Stage) => void; busy?: Partial<Record<Stage, boolean>> }) {
  const theme = useTheme();
  const tone = (c: (typeof STAGES)[number]['color']) => (c === 'grey' ? theme.palette.text.secondary : theme.palette[c].main);
  const step = (s: (typeof STAGES)[number] | typeof DISCARDED_STAGE, compact = false) => {
    const on = value === s.id;
    const col = tone(s.color);
    const Icon = s.icon;
    return (
      <ButtonBase
        key={s.id}
        onClick={() => onChange(s.id)}
        aria-pressed={on}
        title={s.hint}
        sx={{
          flex: compact ? '0 0 auto' : 1,
          minWidth: 0,
          borderRadius: 2,
          px: { xs: 0.5, sm: 0.75 },
          py: 1,
          justifyContent: 'flex-start',
          border: '1px solid',
          borderColor: on ? col : 'divider',
          bgcolor: on ? alpha(col, 0.14) : 'transparent',
          transition: 'background-color .15s, border-color .15s, transform .15s',
          '&:hover': { bgcolor: alpha(col, on ? 0.2 : 0.08) },
          '&:active': { transform: 'scale(0.98)' },
        }}
      >
        <Box sx={{ minWidth: 0, width: '100%', textAlign: 'left' }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Icon sx={{ fontSize: 16, color: on ? col : 'text.secondary', animation: busy?.[s.id] ? 'pulse 1.2s ease-in-out infinite' : undefined, '@keyframes pulse': { '50%': { opacity: 0.35 } } }} />
            <Typography sx={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1, color: on ? col : 'text.primary', fontVariantNumeric: 'tabular-nums' }}>{counts[s.id]}</Typography>
          </Stack>
          <Typography variant="caption" noWrap sx={{ display: 'block', mt: 0.25, fontSize: { xs: 10.5, sm: 11.5 }, color: on ? col : 'text.secondary', fontWeight: on ? 600 : 400 }}>
            {s.label}
          </Typography>
        </Box>
      </ButtonBase>
    );
  };
  return (
    <Stack direction="row" sx={{ alignItems: 'stretch', gap: { xs: 0.5, sm: 0 }, mb: 1.5 }}>
      {STAGES.map((s, i) => (
        <Box key={s.id} sx={{ display: 'contents' }}>
          {step(s)}
          {i < STAGES.length - 1 && <ChevronRight sx={{ color: 'text.disabled', fontSize: 14, mx: -0.25, flexShrink: 0, alignSelf: 'center', display: { xs: 'none', sm: 'block' } }} />}
        </Box>
      ))}
      {/* Discarded sits apart from the pipeline, after a divider. */}
      <Box sx={{ width: '1px', bgcolor: 'divider', mx: { xs: 0.25, sm: 0.75 }, my: 0.5, flexShrink: 0 }} />
      {step(DISCARDED_STAGE)}
    </Stack>
  );
}
