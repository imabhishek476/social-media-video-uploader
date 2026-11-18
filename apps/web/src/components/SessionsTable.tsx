import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import type { LiveSessionDTO, Paginated } from '@shorts/shared-types';
import { formatDateTime, formatDuration, timeAgo } from '../lib/format';
import { StatusChip } from './StatusChip';

interface SessionsTableProps {
  data: Paginated<LiveSessionDTO> | undefined;
  loading: boolean;
  showStreamer?: boolean;
  onSelect: (id: string) => void;
  onPageChange: (page: number, pageSize: number) => void;
  emptyText: string;
}

/** Live-session list (spec §5.3). Duration ticks for sessions still live. */
export function SessionsTable({ data, loading, showStreamer = true, onSelect, onPageChange, emptyText }: SessionsTableProps) {
  return (
    <TableContainer component={Paper} variant="outlined">
      {loading && <LinearProgress sx={{ height: 2 }} />}
      <Table size="small">
        <TableHead>
          <TableRow>
            {showStreamer && <TableCell>Streamer</TableCell>}
            <TableCell>Broadcast</TableCell>
            <TableCell>Session</TableCell>
            <TableCell>Source</TableCell>
            <TableCell>Processing</TableCell>
            <TableCell>Started</TableCell>
            <TableCell>Ended</TableCell>
            <TableCell align="right">Duration</TableCell>
            <TableCell align="right">Clips</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data?.items.map((s) => {
            const live = s.status === 'LIVE' || s.status === 'DETECTED';
            const duration = s.durationSeconds ?? (live && s.startedAt ? (Date.now() - new Date(s.startedAt).getTime()) / 1000 : null);
            return (
              <TableRow key={s.id} hover onClick={() => onSelect(s.id)} sx={{ cursor: 'pointer' }}>
                {showStreamer && <TableCell sx={{ whiteSpace: 'nowrap' }}>{s.streamer.displayName}</TableCell>}
                <TableCell sx={{ maxWidth: 320 }}>
                  <Typography variant="body2" noWrap title={s.title}>
                    {s.title || '—'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    {s.broadcastId}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <StatusChip status={s.status} />
                    {s.lastError && (
                      <Tooltip title={s.lastError}>
                        <ErrorOutline color="warning" fontSize="small" />
                      </Tooltip>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>
                  <StatusChip status={s.sourceMedia.status} />
                </TableCell>
                <TableCell>
                  <StatusChip status={s.processingStatus} />
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Tooltip title={formatDateTime(s.startedAt)}>
                    <span>{timeAgo(s.startedAt)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Tooltip title={formatDateTime(s.endedAt)}>
                    <span>{s.endedAt ? timeAgo(s.endedAt) : live ? 'Live now' : '—'}</span>
                  </Tooltip>
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {formatDuration(duration)}
                </TableCell>
                <TableCell align="right">{s.clipCount}</TableCell>
              </TableRow>
            );
          })}
          {data && data.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={showStreamer ? 9 : 8} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <TablePagination
        component="div"
        count={data?.total ?? 0}
        page={(data?.page ?? 1) - 1}
        rowsPerPage={data?.pageSize ?? 25}
        rowsPerPageOptions={[10, 25, 50, 100]}
        onPageChange={(_e, page) => onPageChange(page + 1, data?.pageSize ?? 25)}
        onRowsPerPageChange={(e) => onPageChange(1, Number(e.target.value))}
      />
    </TableContainer>
  );
}
