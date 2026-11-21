import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import CloudUploadOutlined from '@mui/icons-material/CloudUploadOutlined';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import HourglassEmptyOutlined from '@mui/icons-material/HourglassEmptyOutlined';
import MovieCreationOutlined from '@mui/icons-material/MovieCreationOutlined';
import PeopleAltOutlined from '@mui/icons-material/PeopleAltOutlined';
import SensorsOutlined from '@mui/icons-material/SensorsOutlined';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { describeError } from '../api/client';
import { useDashboardSummary, useSystemStatus } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import RateReviewOutlined from '@mui/icons-material/RateReviewOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import { StatusChip } from '../components/StatusChip';
import { formatDuration, formatUsd, timeAgo } from '../lib/format';

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardHeader title={title} action={action} slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }} />
      <CardContent sx={{ pt: 0 }}>{children}</CardContent>
    </Card>
  );
}

const Empty = ({ text }: { text: string }) => (
  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
    {text}
  </Typography>
);

export function DashboardPage() {
  const summary = useDashboardSummary();
  const system = useSystemStatus();
  const c = summary.data?.counts;

  const cards: Array<{ label: string; value?: number; icon: ReactNode; tone?: 'error' | 'success' | 'warning' | 'info'; to?: string }> = [
    { label: 'Registered streamers', value: c?.streamers, icon: <PeopleAltOutlined fontSize="small" /> },
    { label: 'Live now', value: c?.liveStreamers, icon: <SensorsOutlined fontSize="small" />, tone: 'error' },
    { label: 'Waiting for processing', value: c?.sessionsWaiting, icon: <HourglassEmptyOutlined fontSize="small" />, tone: 'warning' },
    { label: 'Processing', value: c?.sessionsProcessing, icon: <SyncOutlined fontSize="small" />, tone: 'info' },
    { label: 'Shorts generated today', value: c?.shortsGeneratedToday, icon: <MovieCreationOutlined fontSize="small" /> },
    { label: 'Shorts published today', value: c?.shortsPublishedToday, icon: <CloudUploadOutlined fontSize="small" />, tone: 'success' },
    { label: 'Awaiting review', value: c?.awaitingReview, icon: <RateReviewOutlined fontSize="small" />, tone: c?.awaitingReview ? 'warning' : undefined, to: '/clips' },
    { label: 'Queued uploads', value: c?.queuedUploads, icon: <ScheduleOutlined fontSize="small" />, tone: 'info' },
    { label: 'Failed jobs', value: c?.failedJobs, icon: <ErrorOutline fontSize="small" />, tone: c?.failedJobs ? 'error' : undefined, to: '/jobs?status=FAILED' },
  ];
  const costs = summary.data?.costs;

  const navigate = useNavigate();
  const ready = system.data?.ready;
  const yt = system.data?.youtube;
  const workers = system.data?.workers ?? [];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Monitoring, processing and publishing at a glance." />
      {summary.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {describeError(summary.error)}
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {cards.map((card) => (
          <Grid key={card.label} size={{ xs: 6, sm: 4, md: 3, xl: 'grow' }} onClick={card.to ? () => navigate(card.to!) : undefined} sx={{ cursor: card.to ? 'pointer' : undefined }}>
            <StatCard label={card.label} value={card.value} icon={card.icon} tone={card.tone} />
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Panel title="Recent live sessions">
            {summary.data?.recentSessions.length ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Streamer</TableCell>
                    <TableCell>Title</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Clips</TableCell>
                    <TableCell align="right">Started</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.data.recentSessions.map((s) => (
                    <TableRow key={s.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/sessions?session=${s.id}`)}>
                      <TableCell>{s.streamerName}</TableCell>
                      <TableCell sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</TableCell>
                      <TableCell>
                        <StatusChip status={s.status} />
                      </TableCell>
                      <TableCell align="right">{s.clipCount}</TableCell>
                      <TableCell align="right">{timeAgo(s.startedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty text="No live sessions yet. They appear here when a monitored streamer goes live." />
            )}
          </Panel>
        </Grid>

        <Grid size={{ xs: 12, lg: 4 }}>
          <Panel
            title="System health"
            action={
              ready && <Chip size="small" color={ready.status === 'ready' ? 'success' : 'error'} label={ready.status === 'ready' ? 'Healthy' : 'Degraded'} />
            }
          >
            <List dense disablePadding>
              {(['mongo', 'redis'] as const).map((dep) => {
                const check = ready?.checks[dep];
                return (
                  <ListItem key={dep} disableGutters secondaryAction={check && <Chip size="small" variant="outlined" color={check.ok ? 'success' : 'error'} label={check.ok ? 'Up' : 'Down'} />}>
                    <ListItemText
                      primary={dep === 'mongo' ? 'MongoDB' : 'Redis'}
                      secondary={check ? (check.ok ? `${check.latencyMs} ms` : check.error) : 'Checking…'}
                    />
                  </ListItem>
                );
              })}
            </List>
            {yt && (
              <ListItem disableGutters disablePadding sx={{ mb: 1 }}>
                <ListItemText
                  primary={`YouTube Data API (${yt.liveDetection} detection)`}
                  secondary={`Quota today: ${yt.quotaUsedToday.toLocaleString()} / ${yt.dailyQuota.toLocaleString()} units${yt.pausedUntil ? ` · paused until ${new Date(yt.pausedUntil).toLocaleTimeString()}` : ''}`}
                />
              </ListItem>
            )}
            {costs && (
              <ListItem disableGutters disablePadding sx={{ mb: 1 }}>
                <ListItemText
                  primary={`AI spend this month: ${formatUsd(costs.spentUsd)}${costs.budgetUsd ? ` of ${formatUsd(costs.budgetUsd)}` : ''}`}
                  secondary={costs.budgetUsd ? (costs.spentUsd >= costs.budgetUsd ? 'Budget reached: AI steps are paused' : 'Processing pauses when the budget is reached') : 'No monthly budget set (Settings → Costs)'}
                  slotProps={{ secondary: { color: costs.budgetUsd && costs.spentUsd >= costs.budgetUsd ? 'error' : undefined } }}
                />
              </ListItem>
            )}
            <Typography variant="overline" color="text.secondary">
              Workers ({workers.length})
            </Typography>
            {workers.length === 0 ? (
              <Alert severity="warning" variant="outlined" sx={{ mt: 1 }}>
                No worker heartbeat. Start one with <code>npm run dev:worker</code>.
              </Alert>
            ) : (
              <List dense disablePadding>
                {workers.map((w) => (
                  <ListItem key={w.id} disableGutters>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <span>{w.hostname}</span>
                          {w.roles.map((r) => (
                            <Chip key={r} label={r} size="small" />
                          ))}
                        </Stack>
                      }
                      secondary={`pid ${w.pid} · up ${formatDuration((Date.now() - new Date(w.startedAt).getTime()) / 1000)} · beat ${timeAgo(w.lastHeartbeatAt)}`}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Panel>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Panel title="Latest generated Shorts">
            {summary.data?.latestClips.length ? (
              <List dense disablePadding>
                {summary.data.latestClips.map((clip) => (
                  <ListItem key={clip.id} disableGutters secondaryAction={<StatusChip status={clip.renderStatus} />}>
                    <ListItemText primary={clip.title || 'Untitled clip'} secondary={`${clip.streamerName} · ${formatDuration(clip.durationSeconds)} · ${timeAgo(clip.createdAt)}`} />
                  </ListItem>
                ))}
              </List>
            ) : (
              <Empty text="No Shorts generated yet." />
            )}
          </Panel>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Panel title="Recent uploads">
            {summary.data?.recentUploads.length ? (
              <List dense disablePadding>
                {summary.data.recentUploads.map((clip) => (
                  <ListItem key={clip.id} disableGutters>
                    <ListItemText
                      primary={
                        clip.youtubeUrl ? (
                          <Link href={clip.youtubeUrl} target="_blank" rel="noopener noreferrer">
                            {clip.title}
                          </Link>
                        ) : (
                          clip.title
                        )
                      }
                      secondary={`${clip.streamerName} · published ${timeAgo(clip.publishedAt)}${clip.views !== null ? ` · ${clip.views.toLocaleString()} views` : ''}`}
                    />
                  </ListItem>
                ))}
              </List>
            ) : (
              <Empty text="Nothing published yet." />
            )}
          </Panel>
        </Grid>

        {summary.data?.topShorts.length ? (
          <Grid size={{ xs: 12 }}>
            <Panel title="Top Shorts by views">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Title</TableCell>
                    <TableCell>Streamer</TableCell>
                    <TableCell align="right">Views</TableCell>
                    <TableCell align="right">Likes</TableCell>
                    <TableCell align="right">Published</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.data.topShorts.map((clip) => (
                    <TableRow key={clip.id}>
                      <TableCell>
                        {clip.youtubeUrl ? (
                          <Link href={clip.youtubeUrl} target="_blank" rel="noopener noreferrer">
                            {clip.title}
                          </Link>
                        ) : (
                          clip.title
                        )}
                      </TableCell>
                      <TableCell>{clip.streamerName}</TableCell>
                      <TableCell align="right">{(clip.views ?? 0).toLocaleString()}</TableCell>
                      <TableCell align="right">{(clip.likes ?? 0).toLocaleString()}</TableCell>
                      <TableCell align="right">{timeAgo(clip.publishedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </Grid>
        ) : null}
      </Grid>
    </>
  );
}
