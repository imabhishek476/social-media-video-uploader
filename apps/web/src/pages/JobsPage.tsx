import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
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
import { JobStatus, JobType, enumValues } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useJobs, useSystemStatus, type JobFilters } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { StatusChip } from '../components/StatusChip';
import { formatDateTime, humanize, timeAgo } from '../lib/format';

export function JobsPage() {
  const [filters, setFilters] = useState<JobFilters>({ page: 1, pageSize: 25 });
  const jobs = useJobs(filters);
  const system = useSystemStatus();

  return (
    <>
      <PageHeader title="Job Monitor" subtitle="Background queues and every processing attempt." />

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Queues
      </Typography>
      <Grid container spacing={1.5} sx={{ mb: 3 }}>
        {(system.data?.queues ?? []).map((q) => (
          <Grid key={q.queue} size={{ xs: 6, sm: 4, md: 3, xl: 'grow' }}>
            <Card variant="outlined" sx={{ p: 1.5, height: '100%' }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                {q.queue}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {q.waiting} waiting · {q.active} active · {q.delayed} delayed
                <br />
                {q.completed} done · <Typography component="span" variant="caption" color={q.failed ? 'error' : 'inherit'}>{q.failed} failed</Typography>
              </Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="Status"
          value={filters.status ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, page: 1, status: (e.target.value || undefined) as JobStatus | undefined }))}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">All</MenuItem>
          {enumValues(JobStatus).map((s) => (
            <MenuItem key={s} value={s}>
              {humanize(s)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Job type"
          value={filters.jobType ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, page: 1, jobType: (e.target.value || undefined) as JobType | undefined }))}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">All</MenuItem>
          {enumValues(JobType).map((t) => (
            <MenuItem key={t} value={t}>
              {humanize(t)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {jobs.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {describeError(jobs.error)}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined">
        {jobs.isFetching && <LinearProgress sx={{ height: 2 }} />}
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Type</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Related</TableCell>
              <TableCell align="right">Attempts</TableCell>
              <TableCell align="right">Progress</TableCell>
              <TableCell>Note / error</TableCell>
              <TableCell>Created</TableCell>
              <TableCell>Finished</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {jobs.data?.items.map((job) => (
              <TableRow key={job.id} hover>
                <TableCell>{humanize(job.jobType)}</TableCell>
                <TableCell>
                  <StatusChip status={job.status} />
                </TableCell>
                <TableCell>{job.entityType ? `${job.entityType} ${job.entityId?.slice(-6) ?? ''}` : '—'}</TableCell>
                <TableCell align="right">
                  {job.attempts}/{job.maxAttempts}
                </TableCell>
                <TableCell align="right">{job.progress}%</TableCell>
                <TableCell sx={{ maxWidth: 280 }}>
                  {job.status === 'PENDING' && job.lastError?.startsWith('Deferred until ') ? (
                    // Not an error: the job is waiting on purpose (publish time, quota, upload window…).
                    <Tooltip title={job.lastError}>
                      <Typography variant="body2" color="info.main" noWrap>
                        {(() => {
                          const m = job.lastError.match(/^Deferred until (\S+): (.*)$/);
                          return m ? `Waiting until ${formatDateTime(m[1]!)}: ${m[2]}` : job.lastError;
                        })()}
                      </Typography>
                    </Tooltip>
                  ) : job.lastError ? (
                    <Tooltip title={job.lastError}>
                      <Typography variant="body2" color="error" noWrap>
                        {job.errorCode ? `[${job.errorCode}] ` : ''}
                        {job.lastError}
                      </Typography>
                    </Tooltip>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <Tooltip title={formatDateTime(job.createdAt)}>
                    <span>{timeAgo(job.createdAt)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell>{timeAgo(job.completedAt)}</TableCell>
              </TableRow>
            ))}
            {jobs.data && jobs.data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  No jobs match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination
          component="div"
          count={jobs.data?.total ?? 0}
          page={filters.page - 1}
          rowsPerPage={filters.pageSize}
          rowsPerPageOptions={[10, 25, 50, 100]}
          onPageChange={(_e, page) => setFilters((f) => ({ ...f, page: page + 1 }))}
          onRowsPerPageChange={(e) => setFilters((f) => ({ ...f, page: 1, pageSize: Number(e.target.value) }))}
        />
      </TableContainer>
    </>
  );
}
