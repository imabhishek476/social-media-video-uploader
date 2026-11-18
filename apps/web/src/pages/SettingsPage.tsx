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
import { useMe, useSettings, useUpdateSettings } from '../api/hooks';
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
    ],
  },
  {
    section: 'publishing',
    title: 'Publishing',
    description: 'Every Short publishes to the one central YouTube channel.',
    fields: [
      { key: 'mode', label: 'Publishing mode', kind: 'select', options: enumValues(PublishingMode) },
      { key: 'privacyStatus', label: 'Default privacy', kind: 'select', options: enumValues(PrivacyStatus) },
      { key: 'dailyUploadLimit', label: 'Daily upload limit', kind: 'number' },
      { key: 'minMinutesBetweenUploads', label: 'Min gap between uploads', kind: 'number', unit: 'min' },
      { key: 'categoryId', label: 'YouTube category ID', kind: 'text', helper: '20 = Gaming, 24 = Entertainment' },
    ],
  },
  {
    section: 'providers',
    title: 'Providers',
    description: 'Pluggable integrations. Credentials stay in environment variables.',
    fields: [
      { key: 'transcription', label: 'Transcription provider', kind: 'text' },
      { key: 'llm', label: 'Highlight / metadata LLM', kind: 'text' },
      { key: 'videoSource', label: 'Video source provider', kind: 'text' },
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

  useEffect(() => {
    if (settings.data && !draft) {
      const { youtube: _y, updatedAt: _u, ...values } = settings.data;
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
        const { youtube: _y, updatedAt: _u, ...values } = data;
        setDraft(structuredClone(values) as unknown as Draft);
        setSaved(true);
      },
    });
  };

  const reset = () => {
    if (!settings.data) return;
    const { youtube: _y, updatedAt: _u, ...values } = settings.data;
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

      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardHeader
          title="Central YouTube channel"
          subheader="OAuth connection for the single destination channel. Available in Phase 6."
          action={yt && <Chip size="small" color={yt.connected ? 'success' : 'default'} label={yt.connected ? 'Connected' : 'Not connected'} />}
          slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }}
        />
        {yt?.connected && (
          <CardContent sx={{ pt: 0 }}>
            <Typography variant="body2">
              {yt.channelTitle} ({yt.channelId}) · connected {formatDateTime(yt.connectedAt)}
            </Typography>
          </CardContent>
        )}
      </Card>

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
                        <Grid key={field.key} size={{ xs: 12, sm: 6 }}>
                          <TextField
                            fullWidth
                            size="small"
                            label={field.label}
                            value={value}
                            disabled={!canEdit}
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
