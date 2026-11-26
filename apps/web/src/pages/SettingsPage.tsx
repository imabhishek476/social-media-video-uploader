import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { UserRole, type AppSettingsInput } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { InstagramCard } from '../components/InstagramCard';
import { useConnectYouTube, useDisconnectYouTube, useMe, useSettings, useUpdateSettings } from '../api/hooks';
import { useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime } from '../lib/format';

import { ALL_FIELDS, GroupCard, TABS, type Draft, type FieldDef } from '../components/settings/SettingsFields';

export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const { data: me } = useMe();
  const canEdit = me?.role === UserRole.ADMIN;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [params, setParams] = useSearchParams();
  const connect = useConnectYouTube();
  const disconnect = useDisconnectYouTube();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const oauthResult = params.get('youtube') === 'connected' ? { ok: true, text: `Connected ${params.get('channel') ?? 'the channel'}.` } : params.get('youtube_error') ? { ok: false, text: params.get('youtube_error')! } : null;
  const tab = params.get('tab') ?? (oauthResult ? 'accounts' : 'publishing');
  const setTab = (id: string) => setParams({ tab: id }, { replace: true });

  const fromServer = () => {
    const { youtube: _y, instagram: _i, updatedAt: _u, ...values } = settings.data!;
    return structuredClone(values) as unknown as Draft;
  };

  useEffect(() => {
    if (settings.data && !draft) setDraft(fromServer());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data, draft]);

  const changed = useMemo(() => {
    if (!draft || !settings.data) return [] as FieldDef[];
    return ALL_FIELDS.filter((f) => String(draft[f.section][f.key]) !== String((settings.data[f.section] as Record<string, unknown>)[f.key]));
  }, [draft, settings.data]);
  const dirty = changed.length > 0;
  const changedTabs = new Set(TABS.filter((t) => t.groups.some((g) => g.fields.some((f) => changed.includes(f)))).map((t) => t.id));

  const setField = (field: FieldDef, raw: string) =>
    setDraft((d) => d && { ...d, [field.section]: { ...d[field.section], [field.key]: field.kind === 'number' || field.numeric ? (raw === '' ? '' : Number(raw)) : raw } });

  const save = () => {
    if (!draft) return;
    update.mutate(draft as unknown as AppSettingsInput, {
      onSuccess: (data) => {
        const { youtube: _y, instagram: _i, updatedAt: _u, ...values } = data;
        setDraft(structuredClone(values) as unknown as Draft);
        setSaved(true);
      },
    });
  };
  const reset = () => {
    if (!settings.data) return;
    setDraft(fromServer());
    update.reset();
  };

  const yt = settings.data?.youtube;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  return (
    <>
      <PageHeader title="Settings" subtitle={settings.data?.updatedAt ? `Last saved ${formatDateTime(settings.data.updatedAt)}` : 'How Shorts are found, made and published.'} />

      {!canEdit && me && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You have read-only access. Only admins can change settings.
        </Alert>
      )}
      {settings.isError && <Alert severity="error">{describeError(settings.error)}</Alert>}

      <Tabs value={current.id} onChange={(_, v: string) => setTab(v)} variant="scrollable" sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        {TABS.map((t) => (
          <Tab
            key={t.id}
            value={t.id}
            label={
              <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                <span>{t.label}</span>
                {changedTabs.has(t.id) && <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }} />}
                {t.id === 'accounts' && yt && !yt.connected && <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'error.main' }} />}
              </Stack>
            }
          />
        ))}
      </Tabs>

      {current.id === 'accounts' ? (
        <>
          {oauthResult && (
            <Alert severity={oauthResult.ok ? 'success' : 'error'} sx={{ mb: 2 }} onClose={() => setParams({ tab: 'accounts' }, { replace: true })}>
              YouTube: {oauthResult.text}
            </Alert>
          )}
          <Card variant="outlined" sx={{ mb: 2 }}>
            <CardHeader
              title="YouTube channel"
              subheader="Every approved Short uploads here."
              action={
                yt && (
                  <Chip
                    size="small"
                    color={yt.connected ? 'success' : yt.status === 'ERROR' ? 'error' : 'default'}
                    label={yt.connected ? 'Connected' : yt.status === 'ERROR' ? 'Needs reconnect' : 'Not connected'}
                  />
                )
              }
              slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }}
            />
            {yt && (
              <CardContent sx={{ pt: 0 }}>
                <Stack spacing={1.5}>
                  {yt.channelTitle && (
                    <Typography variant="body2">
                      {yt.channelTitle} · connected {formatDateTime(yt.connectedAt)}
                    </Typography>
                  )}
                  {yt.status === 'ERROR' && yt.lastError && <Alert severity="error">{yt.lastError}</Alert>}
                  {!yt.oauthConfigured && <Alert severity="warning">OAuth client or ENCRYPTION_KEY is missing in .env.</Alert>}
                  {canEdit && yt.oauthConfigured && (
                    <Stack direction="row" spacing={1}>
                      <Button variant={yt.connected ? 'outlined' : 'contained'} disabled={connect.isPending} onClick={() => connect.mutate()}>
                        {yt.connected ? 'Reconnect' : 'Connect YouTube channel'}
                      </Button>
                      {yt.channelId && (
                        <Button color="error" disabled={disconnect.isPending} onClick={() => setConfirmDisconnect(true)}>
                          Disconnect
                        </Button>
                      )}
                    </Stack>
                  )}
                  {(connect.isError || disconnect.isError) && <Alert severity="error">{describeError(connect.error ?? disconnect.error)}</Alert>}
                </Stack>
              </CardContent>
            )}
          </Card>
          <InstagramCard ig={settings.data?.instagram} canEdit={canEdit} />
        </>
      ) : !draft ? (
        <Skeleton variant="rounded" height={400} />
      ) : (
        <Stack spacing={2} sx={{ maxWidth: 860 }}>
          {current.groups.map((g) => (
            <GroupCard key={g.title} group={g} draft={draft} canEdit={canEdit} onChange={setField} />
          ))}
        </Stack>
      )}

      {dirty && (
        <Paper elevation={8} sx={{ position: 'sticky', bottom: 16, mt: 2, maxWidth: 860, px: 2, py: 1.25, zIndex: 10, border: 1, borderColor: 'warning.main' }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" sx={{ flexGrow: 1 }}>
              {changed.length} unsaved change{changed.length === 1 ? '' : 's'}
            </Typography>
            <Button onClick={reset} disabled={update.isPending}>
              Discard
            </Button>
            <Button variant="contained" onClick={save} disabled={!canEdit || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </Stack>
          {update.isError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {describeError(update.error)}
            </Alert>
          )}
        </Paper>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect YouTube channel?"
        body="Uploads stop until a channel is connected again. Already published Shorts stay on YouTube."
        confirmLabel="Disconnect"
        danger
        busy={disconnect.isPending}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => {
          setConfirmDisconnect(false);
          disconnect.mutate();
        }}
      />
      <Snackbar open={saved} autoHideDuration={3000} onClose={() => setSaved(false)} message="Settings saved" />
    </>
  );
}
