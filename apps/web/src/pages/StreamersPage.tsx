import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Add from '@mui/icons-material/Add';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import OpenInNew from '@mui/icons-material/OpenInNew';
import Search from '@mui/icons-material/Search';
import { LiveStatus, UserRole, enumValues, type StreamerDTO } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useMe, useSetMonitoring, useStreamers, useSystemStatus, type StreamerFilters } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../components/StatusChip';
import { StreamerActions } from '../components/StreamerActions';
import { StreamerFormDialog } from '../components/StreamerFormDialog';
import { formatDateTime, humanize, timeAgo } from '../lib/format';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function StreamersPage() {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const canEdit = me?.role === UserRole.ADMIN;
  const system = useSystemStatus();
  const mockProvider = system.data?.youtube?.provider === 'mock';

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const [filters, setFilters] = useState<StreamerFilters>({ page: 1, pageSize: 25 });
  const query = useStreamers({ ...filters, search: debouncedSearch || undefined });
  const setMonitoring = useSetMonitoring();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StreamerDTO | null>(null);

  const openCreate = () => (setEditing(null), setFormOpen(true));
  const openEdit = (s: StreamerDTO) => (setEditing(s), setFormOpen(true));

  return (
    <>
      <PageHeader
        title="Streamers"
        subtitle="YouTube channels monitored for live broadcasts. Every Short publishes to the one central channel."
        actions={
          canEdit && (
            <Button variant="contained" startIcon={<Add />} onClick={openCreate}>
              Add streamer
            </Button>
          )
        }
      />

      {mockProvider && (
        <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
          The <strong>mock YouTube provider</strong> is active (no <code>YOUTUBE_API_KEY</code>). Any @handle resolves to a fake channel; try{' '}
          <code>@mock-gamer</code>. Use a row’s ⋮ menu to simulate a broadcast starting and ending.
        </Alert>
      )}
      {query.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {describeError(query.error)}
        </Alert>
      )}
      {setMonitoring.isError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setMonitoring.reset()}>
          {describeError(setMonitoring.error)}
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField
          size="small"
          placeholder="Search name, @handle, channel ID, tag"
          value={search}
          onChange={(e) => (setSearch(e.target.value), setFilters((f) => ({ ...f, page: 1 })))}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> } }}
          sx={{ minWidth: { sm: 320 } }}
        />
        <TextField
          select
          size="small"
          label="Live status"
          value={filters.liveStatus ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, page: 1, liveStatus: (e.target.value || undefined) as LiveStatus | undefined }))}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="">All</MenuItem>
          {enumValues(LiveStatus).map((s) => (
            <MenuItem key={s} value={s}>
              {humanize(s)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Monitoring"
          value={filters.monitoring ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, page: 1, monitoring: (e.target.value || undefined) as StreamerFilters['monitoring'] }))}
          sx={{ minWidth: 150 }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="enabled">Enabled</MenuItem>
          <MenuItem value="paused">Paused</MenuItem>
        </TextField>
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        {query.isFetching && <LinearProgress sx={{ height: 2 }} />}
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Streamer</TableCell>
              <TableCell>Live status</TableCell>
              <TableCell>Monitoring</TableCell>
              <TableCell>Last checked</TableCell>
              <TableCell>Last live session</TableCell>
              <TableCell align="right">Sessions</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {query.data?.items.map((s) => (
              <TableRow key={s.id} hover onClick={() => navigate(`/streamers/${s.id}`)} sx={{ cursor: 'pointer' }}>
                <TableCell>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 220 }}>
                    <Avatar src={s.thumbnailUrl ?? undefined} sx={{ width: 36, height: 36 }}>
                      {s.displayName.slice(0, 1)}
                    </Avatar>
                    <div style={{ minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                        {s.displayName}
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                        <Link
                          href={s.channelUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="caption"
                          color="text.secondary"
                          onClick={(e) => e.stopPropagation()}
                          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, whiteSpace: 'nowrap' }}
                        >
                          {s.handle ?? s.channelId}
                          <OpenInNew sx={{ fontSize: 12 }} />
                        </Link>
                        {s.tags.slice(0, 2).map((t) => (
                          <Chip key={t} label={t} size="small" sx={{ height: 18, fontSize: 11 }} />
                        ))}
                      </Stack>
                      {s.handle && (
                        <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace', display: 'block' }}>
                          {s.channelId}
                        </Typography>
                      )}
                    </div>
                  </Stack>
                </TableCell>
                <TableCell sx={{ maxWidth: 240 }}>
                  <StatusChip status={s.liveStatus} />
                  {s.currentLiveTitle && (
                    <Typography variant="caption" color="text.secondary" noWrap component="div" title={s.currentLiveTitle}>
                      {s.currentLiveTitle}
                    </Typography>
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Tooltip title={canEdit ? (s.monitoringEnabled ? 'Pause monitoring' : 'Resume monitoring') : ''}>
                    <span>
                      <Switch
                        size="small"
                        checked={s.monitoringEnabled}
                        disabled={!canEdit || setMonitoring.isPending}
                        onChange={(e) => setMonitoring.mutate({ id: s.id, enabled: e.target.checked })}
                        slotProps={{ input: { 'aria-label': `Monitoring for ${s.displayName}` } }}
                      />
                    </span>
                  </Tooltip>
                  <Typography variant="caption" color="text.secondary">
                    {s.monitoringEnabled ? 'Enabled' : 'Paused'}
                  </Typography>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Tooltip title={s.lastCheckedAt ? formatDateTime(s.lastCheckedAt) : 'Not checked yet'}>
                      <span>{s.lastCheckedAt ? timeAgo(s.lastCheckedAt) : s.monitoringEnabled ? 'Pending' : '—'}</span>
                    </Tooltip>
                    {s.lastError && (
                      <Tooltip title={`${s.consecutiveCheckFailures} failed check(s): ${s.lastError}`}>
                        <ErrorOutline color="warning" fontSize="small" />
                      </Tooltip>
                    )}
                  </Stack>
                </TableCell>
                <TableCell sx={{ maxWidth: 220 }}>
                  {s.lastLiveSession ? (
                    <>
                      <Typography variant="body2" noWrap title={s.lastLiveSession.title}>
                        {s.lastLiveSession.title || 'Untitled'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {timeAgo(s.lastLiveSession.startedAt)} · {humanize(s.lastLiveSession.status)}
                      </Typography>
                    </>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      None yet
                    </Typography>
                  )}
                </TableCell>
                <TableCell align="right">{s.totalSessions}</TableCell>
                <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                  <StreamerActions streamer={s} canEdit={canEdit} mockProvider={mockProvider} onEdit={() => openEdit(s)} />
                </TableCell>
              </TableRow>
            ))}
            {query.data && query.data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 6 }}>
                  <Typography color="text.secondary" gutterBottom>
                    {debouncedSearch || filters.liveStatus || filters.monitoring ? 'No streamers match these filters.' : 'No streamers yet.'}
                  </Typography>
                  {canEdit && !debouncedSearch && !filters.liveStatus && !filters.monitoring && (
                    <Button startIcon={<Add />} onClick={openCreate}>
                      Add your first streamer
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={query.data?.total ?? 0}
          page={filters.page - 1}
          rowsPerPage={filters.pageSize}
          rowsPerPageOptions={[10, 25, 50, 100]}
          onPageChange={(_e, page) => setFilters((f) => ({ ...f, page: page + 1 }))}
          onRowsPerPageChange={(e) => setFilters((f) => ({ ...f, page: 1, pageSize: Number(e.target.value) }))}
        />
      </TableContainer>

      <StreamerFormDialog open={formOpen} streamer={editing} onClose={() => setFormOpen(false)} />
    </>
  );
}
