import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { SessionStatus, UserRole, enumValues } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useMe, useSessions, useStreamers, type SessionFilters } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { ImportSessionDialog } from '../components/ImportSessionDialog';
import Button from '@mui/material/Button';
import AddLink from '@mui/icons-material/AddLink';
import { SessionDrawer } from '../components/SessionDrawer';
import { SessionsTable } from '../components/SessionsTable';
import { humanize } from '../lib/format';

export function LiveSessionsPage() {
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  // Filters live in the URL so a filtered view can be linked/bookmarked.
  const filters: SessionFilters = {
    ...paging,
    status: (params.get('status') as SessionStatus | null) ?? undefined,
    streamerId: params.get('streamer') ?? undefined,
  };
  const sessions = useSessions(filters);
  const streamers = useStreamers({ page: 1, pageSize: 100 });
  const selected = params.get('session');
  const [importOpen, setImportOpen] = useState(false);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    if (key !== 'session') setPaging((p) => ({ ...p, page: 1 }));
  };

  return (
    <>
      <PageHeader
        title="Live Sessions"
        subtitle="Every detected broadcast. Processing starts automatically once a stream is confirmed ended."
        actions={
          me?.role === UserRole.ADMIN && (
            <Button variant="contained" startIcon={<AddLink />} onClick={() => setImportOpen(true)}>
              Add missed live
            </Button>
          )
        }
      />
      <ImportSessionDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={(id) => setParam('session', id)} />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <TextField select size="small" label="Status" value={filters.status ?? ''} onChange={(e) => setParam('status', e.target.value || null)} sx={{ minWidth: 180 }}>
          <MenuItem value="">All</MenuItem>
          {enumValues(SessionStatus).map((s) => (
            <MenuItem key={s} value={s}>
              {humanize(s)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Streamer"
          value={filters.streamerId ?? ''}
          onChange={(e) => setParam('streamer', e.target.value || null)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">All streamers</MenuItem>
          {(streamers.data?.items ?? []).map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.displayName}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      {sessions.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {describeError(sessions.error)}
        </Alert>
      )}

      <SessionsTable
        data={sessions.data}
        loading={sessions.isFetching}
        onSelect={(id) => setParam('session', id)}
        onPageChange={(page, pageSize) => setPaging({ page, pageSize })}
        emptyText={filters.status || filters.streamerId ? 'No sessions match these filters.' : 'No live sessions yet. They appear when a monitored streamer goes live.'}
      />

      <SessionDrawer sessionId={selected} canEdit={me?.role === UserRole.ADMIN} onClose={() => setParam('session', null)} />
    </>
  );
}
