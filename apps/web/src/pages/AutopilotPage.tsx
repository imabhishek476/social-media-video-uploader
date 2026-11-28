import { useState, type ReactElement } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import CheckCircle from '@mui/icons-material/CheckCircle';
import PanTool from '@mui/icons-material/PanTool';
import Pause from '@mui/icons-material/Pause';
import PlayArrow from '@mui/icons-material/PlayArrow';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import { UserRole } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useAutopilot, useAutopilotSwitch, useMe, type AutopilotEvent } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';

const KIND: Record<AutopilotEvent['kind'], { label: string; color: 'success' | 'warning' | 'error' | 'info'; icon: ReactElement }> = {
  PUBLISHED: { label: 'Published', color: 'success', icon: <CheckCircle fontSize="small" /> },
  HELD: { label: 'Held for review', color: 'warning', icon: <PanTool fontSize="small" /> },
  PAUSED: { label: 'Paused', color: 'error', icon: <Pause fontSize="small" /> },
  RESUMED: { label: 'Resumed', color: 'info', icon: <PlayArrow fontSize="small" /> },
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Phase 9: what autopilot is doing, every decision it made and why, and the pause switch. */
export function AutopilotPage() {
  const { data: me } = useMe();
  const canEdit = me?.role === UserRole.ADMIN;
  const q = useAutopilot();
  const toggle = useAutopilotSwitch();
  const [filter, setFilter] = useState<'ALL' | AutopilotEvent['kind']>('ALL');
  const st = q.data?.status;
  const events = (q.data?.events ?? []).filter((e) => filter === 'ALL' || e.kind === filter);

  const state = !st ? null : st.paused ? 'paused' : st.enabled ? 'running' : 'off';
  const tone = state === 'running' ? 'success' : state === 'paused' ? 'error' : 'grey';

  return (
    <>
      <PageHeader title="Autopilot" subtitle="Publishes good Shorts without a click, holds the rest for you, and explains every decision." />
      {q.isError && <Alert severity="error">{describeError(q.error)}</Alert>}
      {!st ? (
        <Skeleton variant="rounded" height={140} />
      ) : (
        <Card
          variant="outlined"
          sx={(t) => {
            const c = tone === 'grey' ? t.palette.text.secondary : t.palette[tone].main;
            return { p: { xs: 2, sm: 2.5 }, mb: 3, borderColor: alpha(c, 0.5), background: `linear-gradient(135deg, ${alpha(c, 0.12)}, transparent 60%)` };
          }}
        >
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
            <SmartToyOutlined sx={{ fontSize: 44, color: tone === 'grey' ? 'text.secondary' : `${tone}.main` }} />
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {state === 'running' ? 'Autopilot is on' : state === 'paused' ? 'Autopilot is paused' : 'Autopilot is off'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {state === 'running' && `Shorts scoring ${st.minScore}+ that pass the checks are published on schedule. The rest wait in Clip Studio.`}
                {state === 'paused' && `${st.pausedReason ?? 'Paused'}${st.pausedAt ? ` · since ${when(st.pausedAt)}` : ''}. New Shorts wait for your review.`}
                {state === 'off' && 'Every Short waits for you to approve it (streamers set to “On” still use autopilot).'}
              </Typography>
              {state === 'off' && (
                <Link component={RouterLink} to="/settings?tab=publishing" variant="body2">
                  Turn it on in Settings → Publishing
                </Link>
              )}
            </Box>
            <Stack direction="row" spacing={3} sx={{ flexShrink: 0 }}>
              <Stat value={st.today.published} label="published (24 h)" color="success.main" />
              <Stat value={st.today.held} label="held (24 h)" color="warning.main" />
            </Stack>
            {canEdit && state !== 'off' && (
              <Button
                variant={state === 'paused' ? 'contained' : 'outlined'}
                color={state === 'paused' ? 'success' : 'error'}
                startIcon={state === 'paused' ? <PlayArrow /> : <Pause />}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(state === 'paused' ? 'resume' : 'pause')}
                sx={{ flexShrink: 0 }}
              >
                {state === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            )}
          </Stack>
          {toggle.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {describeError(toggle.error)}
            </Alert>
          )}
        </Card>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' }, mb: 1.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Decisions
        </Typography>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} sx={{ flexWrap: 'wrap' }}>
          <ToggleButton value="ALL">All</ToggleButton>
          <ToggleButton value="PUBLISHED">Published</ToggleButton>
          <ToggleButton value="HELD">Held</ToggleButton>
          <ToggleButton value="PAUSED">Pauses</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {q.isPending ? (
        <Skeleton variant="rounded" height={200} />
      ) : events.length === 0 ? (
        <Card variant="outlined" sx={{ p: 3, textAlign: 'center', borderStyle: 'dashed' }}>
          <Typography variant="body2" color="text.secondary">
            No decisions yet. They appear here when a stream’s Shorts finish rendering.
          </Typography>
        </Card>
      ) : (
        <Stack spacing={1}>
          {events.map((e) => {
            const k = KIND[e.kind];
            return (
              <Card key={e.id} variant="outlined" sx={{ p: 1.5 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
                  <Chip size="small" color={k.color} icon={k.icon} label={k.label} sx={{ alignSelf: { xs: 'flex-start', sm: 'center' }, minWidth: 128, justifyContent: 'flex-start' }} />
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    {e.clipId && e.liveSessionId ? (
                      <Link component={RouterLink} to={`/clips?session=${e.liveSessionId}&stage=${e.kind === 'HELD' ? 'READY' : 'PUBLISHED'}`} underline="hover" sx={{ fontWeight: 600 }}>
                        {e.title || 'Untitled Short'}
                      </Link>
                    ) : (
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {e.kind === 'PAUSED' ? 'Autopilot paused' : 'Autopilot resumed'}
                        {e.by !== 'autopilot' ? ` by ${e.by}` : ''}
                      </Typography>
                    )}
                    {e.reasons.length > 0 && (
                      <Typography variant="body2" color="text.secondary">
                        {e.reasons.join(' · ')}
                      </Typography>
                    )}
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {when(e.createdAt)}
                  </Typography>
                </Stack>
              </Card>
            );
          })}
        </Stack>
      )}
    </>
  );
}

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <Typography sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1, color, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}
