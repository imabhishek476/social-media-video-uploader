import { useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowBack from '@mui/icons-material/ArrowBack';
import OpenInNew from '@mui/icons-material/OpenInNew';
import { UserRole } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useMe, useSessions, useSettings, useStreamer, useSystemStatus, type SessionFilters } from '../api/hooks';
import { SessionDrawer } from '../components/SessionDrawer';
import { SessionsTable } from '../components/SessionsTable';
import { StatusChip } from '../components/StatusChip';
import { StreamerActions } from '../components/StreamerActions';
import { StreamerFormDialog } from '../components/StreamerFormDialog';
import { formatDateTime, timeAgo } from '../lib/format';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </div>
  );
}

export function StreamerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const canEdit = me?.role === UserRole.ADMIN;
  const streamer = useStreamer(id);
  const settings = useSettings();
  const [sessionFilters, setSessionFilters] = useState<Omit<SessionFilters, 'streamerId'>>({ page: 1, pageSize: 10 });
  const sessions = useSessions({ ...sessionFilters, streamerId: id });
  const [selected, setSelected] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  if (streamer.isError) {
    return (
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Alert severity="error">{describeError(streamer.error)}</Alert>
        <Button component={RouterLink} to="/streamers" startIcon={<ArrowBack />}>
          Back to streamers
        </Button>
      </Stack>
    );
  }
  const s = streamer.data;
  if (!s) return <Skeleton variant="rounded" height={320} />;

  const g = settings.data;
  const prefRows: Array<[string, number | string | null, number | string | undefined]> = [
    ['Max clips per stream', s.preferences.maxClipsPerStream, g?.clips.maxClipsPerStream],
    ['Min highlight score', s.preferences.minHighlightScore, g?.clips.minHighlightScore],
    ['Min clip duration (s)', s.preferences.minClipDurationSeconds, g?.clips.minDurationSeconds],
    ['Max clip duration (s)', s.preferences.maxClipDurationSeconds, g?.clips.maxDurationSeconds],
    ['Language', s.preferences.language, g?.subtitles.language],
  ];

  return (
    <>
      <Button component={RouterLink} to="/streamers" startIcon={<ArrowBack />} size="small" sx={{ mb: 1 }}>
        Streamers
      </Button>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 3 }}>
        <Avatar src={s.thumbnailUrl ?? undefined} sx={{ width: 56, height: 56 }}>
          {s.displayName.slice(0, 1)}
        </Avatar>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 600 }} noWrap>
            {s.displayName}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Link href={s.channelUrl} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              {s.handle ?? s.channelUrl} <OpenInNew sx={{ fontSize: 14 }} />
            </Link>
            <StatusChip status={s.liveStatus} />
            {!s.monitoringEnabled && <Chip size="small" label="Monitoring paused" />}
            {s.tags.map((t) => (
              <Chip key={t} size="small" label={t} variant="outlined" />
            ))}
          </Stack>
        </div>
        <StreamerActions
          streamer={s}
          canEdit={canEdit}
          showView={false}
          onEdit={() => setEditOpen(true)}
          onRemoved={() => navigate('/streamers', { replace: true })}
        />
      </Stack>

      {s.currentLiveTitle && (
        <Alert severity="error" variant="outlined" icon={false} sx={{ mb: 2 }}>
          <strong>Live now:</strong> {s.currentLiveTitle}
        </Alert>
      )}
      {s.lastError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {s.consecutiveCheckFailures} consecutive failed check(s). Last error: {s.lastError}
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Card variant="outlined" sx={{ height: '100%' }}>
            <CardHeader title="Monitoring" slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }} />
            <CardContent sx={{ pt: 0 }}>
              <Grid container spacing={2}>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Channel ID">
                    <span style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{s.channelId}</span>
                  </Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Last checked">{s.lastCheckedAt ? timeAgo(s.lastCheckedAt) : 'Not yet'}</Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Next check">{s.monitoringEnabled ? timeAgo(s.nextCheckAt) : 'Paused'}</Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Monitoring since">{formatDateTime(s.monitoringSince)}</Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Last live">{s.lastLiveAt ? timeAgo(s.lastLiveAt) : 'Never seen live'}</Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Sessions / processed">
                    {s.totalSessions} / {s.totalProcessedStreams}
                  </Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Category">{s.category ?? '—'}</Fact>
                </Grid>
                <Grid size={{ xs: 6, sm: 4 }}>
                  <Fact label="Added">{formatDateTime(s.createdAt)}</Fact>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Card variant="outlined" sx={{ height: '100%' }}>
            <CardHeader
              title="Clip preferences"
              subheader="Blank values use the global Settings."
              slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }}
            />
            <CardContent sx={{ pt: 0 }}>
              {prefRows.map(([label, own, global]) => (
                <Stack key={label} direction="row" sx={{ justifyContent: 'space-between', py: 0.5 }}>
                  <Typography variant="body2" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: own != null ? 600 : 400 }}>
                    {own ?? global ?? '—'}
                    {own == null && (
                      <Typography component="span" variant="caption" color="text.secondary">
                        {' '}
                        (default)
                      </Typography>
                    )}
                  </Typography>
                </Stack>
              ))}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        Live sessions
      </Typography>
      <SessionsTable
        data={sessions.data}
        loading={sessions.isFetching}
        showStreamer={false}
        onSelect={setSelected}
        onPageChange={(page, pageSize) => setSessionFilters({ page, pageSize })}
        emptyText="No broadcasts detected for this channel yet."
      />

      <SessionDrawer sessionId={selected} canEdit={canEdit} onClose={() => setSelected(null)} />
      <StreamerFormDialog open={editOpen} streamer={s} onClose={() => setEditOpen(false)} />
    </>
  );
}
