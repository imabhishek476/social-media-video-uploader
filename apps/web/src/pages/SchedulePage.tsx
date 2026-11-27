import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ScheduledShortDTO } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useBuildCompilation, useCompilations, usePublishNow, useRescheduleClip, useSchedule } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';

/** yyyy-MM-ddTHH:mm in the browser's time zone, for <input type="datetime-local">. */
const toInput = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function Row({ item }: { item: ScheduledShortDTO }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(toInput(item.goLiveAt));
  const move = useRescheduleClip();
  const now = usePublishNow();
  const live = new Date(item.goLiveAt).getTime() <= Date.now();
  const error = move.error ?? now.error;
  return (
    <Card variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
        <Typography variant="h6" sx={{ minWidth: 72, fontVariantNumeric: 'tabular-nums' }}>
          {timeLabel(item.goLiveAt)}
        </Typography>
        <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
          <Link component={RouterLink} to={`/clips?session=${item.liveSessionId}`} underline="hover" noWrap>
            {item.title || 'Untitled Short'}
          </Link>
          <Typography variant="caption" color="text.secondary">
            {item.streamerName}
          </Typography>
        </Stack>
        <Chip
          size="small"
          color={live ? 'success' : item.uploaded ? 'info' : item.uploadStatus === 'UPLOAD_FAILED' ? 'error' : 'default'}
          label={live ? 'Public' : item.uploaded ? 'Uploaded · waiting for slot' : item.uploadStatus === 'UPLOAD_FAILED' ? 'Upload failed' : 'Uploading soon'}
        />
        {!live && !editing && (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={() => setEditing(true)}>
              Move
            </Button>
            <Button size="small" variant="outlined" disabled={now.isPending} onClick={() => now.mutate({ clipId: item.id })}>
              Publish now
            </Button>
          </Stack>
        )}
        {live && item.youtubeUrl && (
          <Button size="small" href={item.youtubeUrl} target="_blank" rel="noreferrer">
            Open
          </Button>
        )}
      </Stack>
      {editing && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: 'center' }}>
          <TextField size="small" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button
            size="small"
            variant="contained"
            disabled={move.isPending}
            onClick={() => move.mutate({ clipId: item.id, goLiveAt: new Date(value).toISOString() }, { onSuccess: () => setEditing(false) })}
          >
            Save
          </Button>
          <Button size="small" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </Stack>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {describeError(error)}
        </Alert>
      )}
      {item.lastError && !error && (
        <Typography variant="caption" color="error">
          {item.lastError}
        </Typography>
      )}
    </Card>
  );
}

const COMPILATION_STATUS: Record<string, { label: string; color: 'success' | 'info' | 'warning' | 'error' | 'default' }> = {
  PUBLISHED: { label: 'Published', color: 'success' },
  BUILDING: { label: 'Building…', color: 'info' },
  UPLOADING: { label: 'Uploading…', color: 'info' },
  SKIPPED: { label: 'Skipped', color: 'warning' },
  FAILED: { label: 'Failed', color: 'error' },
};

/** Weekly "best of" long videos, with a button to build this week's now. */
function Compilations() {
  const list = useCompilations();
  const build = useBuildCompilation();
  return (
    <Card variant="outlined" sx={{ p: 2, mt: 4 }}>
      <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Weekly compilations
        </Typography>
        <Button size="small" variant="outlined" disabled={build.isPending} onClick={() => build.mutate()}>
          {build.isSuccess ? 'Building in the background…' : 'Build this week’s now'}
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Your most-watched Shorts of the week joined into one long video with chapters. Settings → YouTube → Weekly compilation.
      </Typography>
      {build.isError && <Alert severity="error">{describeError(build.error)}</Alert>}
      {!list.data?.items.length && <Typography variant="body2">None yet.</Typography>}
      <Stack spacing={1}>
        {list.data?.items.map((c) => {
          const st = COMPILATION_STATUS[c.status] ?? { label: c.status, color: 'default' as const };
          return (
            <Stack key={c.id} direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
              <Chip size="small" color={st.color} label={st.label} />
              <Typography variant="body2" sx={{ flexGrow: 1 }}>
                {c.title || `Week of ${c.weekKey}`}
                {c.clipCount ? ` · ${c.clipCount} Shorts` : ''}
                {c.durationSeconds ? ` · ${Math.round(c.durationSeconds / 60)} min` : ''}
                {c.lastError && (
                  <Typography component="span" variant="caption" color={c.status === 'FAILED' ? 'error' : 'text.secondary'} sx={{ display: 'block' }}>
                    {c.lastError}
                  </Typography>
                )}
              </Typography>
              {c.youtubeUrl && (
                <Button size="small" href={c.youtubeUrl} target="_blank" rel="noreferrer">
                  Open
                </Button>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}

/** Phase 8: when each approved Short goes public. */
export function SchedulePage() {
  const schedule = useSchedule(14);
  const data = schedule.data;
  const groups = new Map<string, ScheduledShortDTO[]>();
  for (const item of data?.items ?? []) {
    const key = new Date(item.goLiveAt).toDateString();
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return (
    <>
      <PageHeader title="Schedule" subtitle="When each approved Short goes public on YouTube (and Instagram, if cross-posting is on)." />
      {schedule.isError && <Alert severity="error">{describeError(schedule.error)}</Alert>}
      {data && (
        <Alert severity={data.timingMode === 'IMMEDIATE' || data.privacyStatus !== 'public' ? 'warning' : 'info'} sx={{ mb: 2 }}>
          {data.privacyStatus !== 'public' && data.timingMode !== 'IMMEDIATE'
            ? `Scheduling is paused because Default privacy is "${data.privacyStatus}". Set it to public in Settings → Publishing; scheduled Shorts go public at their slot.`
            : data.timingMode === 'IMMEDIATE'
            ? 'Scheduling is off: Shorts go public as soon as they upload. Choose BEST_TIME or FIXED_SLOTS in Settings → Publishing.'
            : `${data.timingMode === 'BEST_TIME' ? 'Best time' : 'Fixed slots'}: ${data.slots.join(', ')} (${data.timezone})${
                data.timingMode === 'BEST_TIME' ? (data.slotsSource === 'learned' ? ', learned from your Shorts’ views.' : '. Using your slot times until about 30 Shorts have views.') : '.'
              }`}
        </Alert>
      )}
      {schedule.isPending && <Skeleton variant="rounded" height={120} />}
      {data && !data.items.length && (
        <Typography color="text.secondary">Nothing scheduled. Approved Shorts appear here with their publish time.</Typography>
      )}
      <Stack spacing={3}>
        {[...groups.entries()].map(([key, items]) => (
          <div key={key}>
            <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
              {dayLabel(items[0]!.goLiveAt)}
            </Typography>
            <Stack spacing={1}>
              {items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </Stack>
          </div>
        ))}
      </Stack>
      <Compilations />
    </>
  );
}
