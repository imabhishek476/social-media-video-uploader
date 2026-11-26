import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  PrivacyStatus,
  PublishingMode,
  ReframingMode,
  SubtitlePosition,
  UserRole,
  enumValues,
  type AppSettingsInput,
} from '@shorts/shared-types';
import { describeError } from '../api/client';
import { InstagramCard } from '../components/InstagramCard';
import { useConnectYouTube, useDisconnectYouTube, useMe, useSettings, useUpdateSettings } from '../api/hooks';
import { useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime, humanize } from '../lib/format';

type Section = keyof AppSettingsInput;

interface FieldDef {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'select' | 'color';
  options?: readonly string[];
  helper?: string;
  unit?: string;
  multiline?: boolean;
  /** Shown but not editable (comes from .env). */
  readOnly?: boolean;
}

/** Declarative form definition — adding a setting is one line here + the shared schema. */
const SECTIONS: Array<{ section: Section; title: string; description: string; fields: FieldDef[] }> = [
  {
    section: 'monitoring',
    title: 'Monitoring',
    description: 'How often streamer channels are checked for live broadcasts.',
    fields: [
      { key: 'intervalSeconds', label: 'Polling interval', kind: 'number', unit: 'sec', helper: 'Min 30s. Mind YouTube API quota.' },
      { key: 'endConfirmationChecks', label: 'End confirmation checks', kind: 'number', helper: 'Consecutive "not live" checks before a stream is marked ended.' },
      { key: 'sessionWatchIntervalSeconds', label: 'Live session re-check', kind: 'number', unit: 'sec', helper: 'How often an ongoing broadcast is re-checked for its end.' },
      { key: 'chatPollSeconds', label: 'Live chat sampling', kind: 'number', unit: 'sec', helper: 'Reads chat activity while live to spot hype moments. ~5 quota units per read (60s ≈ 300/hour). 0 = off.' },
    ],
  },
  {
    section: 'processing',
    title: 'Processing limits',
    description: 'Cost and resource guards for long streams.',
    fields: [
      { key: 'maxConcurrentJobs', label: 'Max concurrent jobs', kind: 'number' },
      { key: 'maxSourceDurationMinutes', label: 'Max source duration', kind: 'number', unit: 'min' },
      { key: 'maxSourceFileSizeMb', label: 'Max source file size', kind: 'number', unit: 'MB' },
    ],
  },
  {
    section: 'clips',
    title: 'Clips',
    description: 'Highlight selection and Short duration.',
    fields: [
      { key: 'defaultDurationSeconds', label: 'Default duration', kind: 'number', unit: 'sec' },
      { key: 'minDurationSeconds', label: 'Min duration', kind: 'number', unit: 'sec' },
      { key: 'maxDurationSeconds', label: 'Max duration', kind: 'number', unit: 'sec' },
      { key: 'maxClipsPerStream', label: 'Max clips per stream', kind: 'number' },
      { key: 'minHighlightScore', label: 'Min highlight score', kind: 'number', helper: '0–100' },
      { key: 'reframingMode', label: 'Reframing mode', kind: 'select', options: enumValues(ReframingMode) },
    ],
  },
  {
    section: 'subtitles',
    title: 'Subtitles',
    description: 'Caption language and burned-in style.',
    fields: [
      { key: 'language', label: 'Language', kind: 'text', helper: 'BCP-47 code, e.g. en, hi' },
      { key: 'fontFamily', label: 'Font family', kind: 'text' },
      { key: 'fontSize', label: 'Font size', kind: 'number', unit: 'px' },
      { key: 'primaryColor', label: 'Text colour', kind: 'color' },
      { key: 'highlightColor', label: 'Highlight colour', kind: 'color' },
      { key: 'position', label: 'Position', kind: 'select', options: enumValues(SubtitlePosition) },
      { key: 'captionStyle', label: 'Caption style', kind: 'select', options: ['STREAMER', 'HYPE', 'BOUNCE', 'CLEAN', 'CUSTOM'], helper: 'STREAMER: glowing caps on the cam/game seam · HYPE: big 2-word red pop · BOUNCE: 3 words cyan · CLEAN: 4 words · CUSTOM: font/size/colours above' },
      { key: 'hookOverlay', label: 'Hook text on video', kind: 'select', options: ['ALWAYS', 'INTRO', 'OFF'], helper: 'Bold hook in a white box at the top: whole clip, first 4 s, or off' },
    ],
  },
  {
    section: 'publishing',
    title: 'Publishing',
    description: 'Every Short publishes to the one central YouTube channel.',
    fields: [
      { key: 'mode', label: 'Publishing mode', kind: 'select', options: enumValues(PublishingMode) },
      { key: 'privacyStatus', label: 'Default privacy', kind: 'select', options: enumValues(PrivacyStatus) },
      { key: 'dailyUploadLimit', label: 'Daily upload limit', kind: 'number', helper: '0 = no limit' },
      { key: 'minMinutesBetweenUploads', label: 'Min gap between uploads', kind: 'number', unit: 'min' },
      { key: 'categoryId', label: 'YouTube category ID', kind: 'text', helper: '20 = Gaming, 24 = Entertainment' },
      { key: 'timingMode', label: 'When Shorts go public', kind: 'select', options: ['BEST_TIME', 'FIXED_SLOTS', 'IMMEDIATE'], helper: 'BEST_TIME: hours that got the most views on this channel (uses the slot times below until there are ~30 Shorts) · FIXED_SLOTS: exactly the times below · IMMEDIATE: as soon as uploaded. Scheduled Shorts upload early as private and YouTube makes them public at the slot. Needs Default privacy = public.' },
      { key: 'slotTimes', label: 'Slot times', kind: 'text', helper: '24-hour times in the time zone below, e.g. 12:30, 15:30, 18:00, 21:00 (one Short per slot)' },
      { key: 'dayGap', label: 'Gap between posting days', kind: 'number', unit: 'days', helper: '0 = post every day · 1 = every other day · 2 = every third day. A posting day still fills all its slots.' },
      { key: 'skipDays', label: 'Days without posts', kind: 'text', helper: 'e.g. Sun, or empty for every day' },
      { key: 'maxPerSourcePerDay', label: 'Max per stream per day', kind: 'number', helper: 'Spreads one stream’s Shorts over several days. 0 = no limit' },
      { key: 'windowStartHour', label: 'Publish window start', kind: 'number', unit: 'h', helper: 'IMMEDIATE mode only: uploads start from this hour…' },
      { key: 'windowEndHour', label: 'Publish window end', kind: 'number', unit: 'h', helper: '…until this hour. 0–24 = any time' },
      { key: 'timezone', label: 'Time zone', kind: 'text', helper: 'IANA name, e.g. Asia/Kolkata' },
      { key: 'descriptionFooter', label: 'Description footer', kind: 'text', multiline: true, helper: 'Added to every new Short above the hashtags (channel name, subscribe line…).' },
      { key: 'channelHashtags', label: 'Channel hashtags', kind: 'text', helper: 'Added to every new Short, e.g. gaming, streamhighlights' },
      { key: 'instagramMode', label: 'Instagram Reels', kind: 'select', options: ['MANUAL', 'WITH_YOUTUBE'], helper: 'WITH_YOUTUBE: approving a Short also posts it as a Reel. MANUAL: use "Post to Instagram" per clip.' },
    ],
  },
  {
    section: 'costs',
    title: 'Costs',
    description: 'Transcription and LLM steps pause when this month\'s estimated AI spend reaches the budget.',
    fields: [{ key: 'monthlyBudgetUsd', label: 'Monthly AI budget', kind: 'number', unit: 'USD', helper: '0 = no cap' }],
  },
  {
    section: 'providers',
    title: 'Providers',
    description: 'What the app is using right now. These come from .env (change them there and restart npm run dev).',
    fields: [
      { key: 'transcription', label: 'Transcription provider', kind: 'text', readOnly: true, helper: 'TRANSCRIPTION_PROVIDER (openai = any OpenAI-compatible Whisper, e.g. Groq)' },
      { key: 'llm', label: 'Highlight / metadata LLM', kind: 'text', readOnly: true, helper: 'LLM_PROVIDER: gemini or anthropic' },
      { key: 'videoSource', label: 'Video source provider', kind: 'text', readOnly: true, helper: 'VIDEO_SOURCE_PROVIDER: local (uploads + inbox), add ,ytdlp to download finished streams' },
    ],
  },
  {
    section: 'retention',
    title: 'Storage retention',
    description: '0 keeps files forever.',
    fields: [
      { key: 'sourceDays', label: 'Source videos', kind: 'number', unit: 'days' },
      { key: 'clipDays', label: 'Rendered clips', kind: 'number', unit: 'days' },
      { key: 'transcriptDays', label: 'Transcripts', kind: 'number', unit: 'days' },
      { key: 'sourceAfterDoneDays', label: 'Source after all Shorts done', kind: 'number', unit: 'days', helper: 'Once every Short is published or rejected' },
    ],
  },
];

type Draft = Record<Section, Record<string, string | number>>;

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

  useEffect(() => {
    if (settings.data && !draft) {
      const { youtube: _y, instagram: _i, updatedAt: _u, ...values } = settings.data;
      setDraft(structuredClone(values) as unknown as Draft);
    }
  }, [settings.data, draft]);

  const dirty = useMemo(() => {
    if (!draft || !settings.data) return false;
    return SECTIONS.some(({ section, fields }) =>
      fields.some((f) => String(draft[section][f.key]) !== String((settings.data[section] as Record<string, unknown>)[f.key])),
    );
  }, [draft, settings.data]);

  const setField = (section: Section, field: FieldDef, raw: string) =>
    setDraft((d) => d && { ...d, [section]: { ...d[section], [field.key]: field.kind === 'number' ? (raw === '' ? '' : Number(raw)) : raw } });

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
    const { youtube: _y, instagram: _i, updatedAt: _u, ...values } = settings.data;
    setDraft(structuredClone(values) as unknown as Draft);
    update.reset();
  };

  const yt = settings.data?.youtube;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={settings.data?.updatedAt ? `Last saved ${formatDateTime(settings.data.updatedAt)}` : 'Global defaults for monitoring, clipping and publishing.'}
        actions={
          <Stack direction="row" spacing={1}>
            <Button onClick={reset} disabled={!dirty || update.isPending}>
              Discard
            </Button>
            <Button variant="contained" onClick={save} disabled={!canEdit || !dirty || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </Stack>
        }
      />

      {!canEdit && me && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You have read-only access. Only admins can change settings.
        </Alert>
      )}
      {update.isError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {describeError(update.error)}
        </Alert>
      )}
      {settings.isError && <Alert severity="error">{describeError(settings.error)}</Alert>}

      {oauthResult && (
        <Alert severity={oauthResult.ok ? 'success' : 'error'} sx={{ mb: 2 }} onClose={() => setParams({}, { replace: true })}>
          YouTube: {oauthResult.text}
        </Alert>
      )}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader
          title="Central YouTube channel"
          subheader="Every approved Short uploads to this one channel."
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
                    {yt.channelTitle} ({yt.channelId}) · connected {formatDateTime(yt.connectedAt)}
                  </Typography>
                )}
                {yt.status === 'ERROR' && yt.lastError && <Alert severity="error">{yt.lastError}</Alert>}
                {!yt.oauthConfigured && <Alert severity="warning">OAuth client or ENCRYPTION_KEY is missing in .env.</Alert>}
                {canEdit && yt.oauthConfigured && (
                  <Stack direction="row" spacing={1}>
                    <Button variant={yt.connected ? 'outlined' : 'contained'} disabled={connect.isPending} onClick={() => connect.mutate()}>
                      {yt.connected ? 'Reconnect' : yt.status === 'ERROR' ? 'Reconnect channel' : 'Connect YouTube channel'}
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

      {!draft ? (
        <Skeleton variant="rounded" height={400} />
      ) : (
        <Grid container spacing={2}>
          {SECTIONS.map(({ section, title, description, fields }) => (
            <Grid key={section} size={{ xs: 12, lg: 6 }}>
              <Card variant="outlined" sx={{ height: '100%' }}>
                <CardHeader title={title} subheader={description} slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }} />
                <CardContent sx={{ pt: 0 }}>
                  <Grid container spacing={2}>
                    {fields.map((field) => {
                      const value = draft[section][field.key] ?? '';
                      return (
                        <Grid key={field.key} size={{ xs: 12, sm: field.multiline ? 12 : 6 }}>
                          <TextField
                            fullWidth
                            multiline={field.multiline}
                            minRows={field.multiline ? 2 : undefined}
                            size="small"
                            label={field.label}
                            value={value}
                            disabled={!canEdit || field.readOnly}
                            select={field.kind === 'select'}
                            type={field.kind === 'number' ? 'number' : field.kind === 'color' ? 'color' : 'text'}
                            helperText={field.helper}
                            onChange={(e) => setField(section, field, e.target.value)}
                            slotProps={{
                              input: field.unit ? { endAdornment: <Typography variant="caption" color="text.secondary">{field.unit}</Typography> } : undefined,
                            }}
                          >
                            {field.options?.map((o) => (
                              <MenuItem key={o} value={o}>
                                {humanize(o)}
                              </MenuItem>
                            ))}
                          </TextField>
                        </Grid>
                      );
                    })}
                  </Grid>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      <Snackbar open={saved} autoHideDuration={3000} onClose={() => setSaved(false)} message="Settings saved" />
    </>
  );
}
