import { useEffect, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMore from '@mui/icons-material/ExpandMore';
import type { StreamerDTO, StreamerPreferencesInput } from '@shorts/shared-types';
import { ApiError, describeError } from '../api/client';
import { useCreateStreamer, useUpdateStreamer } from '../api/hooks';

const PREF_FIELDS: Array<{ key: keyof StreamerPreferencesInput; label: string; kind: 'number' | 'text'; helper?: string }> = [
  { key: 'maxClipsPerStream', label: 'Max clips per stream', kind: 'number' },
  { key: 'minHighlightScore', label: 'Min highlight score', kind: 'number', helper: '0–100' },
  { key: 'minClipDurationSeconds', label: 'Min clip duration (s)', kind: 'number' },
  { key: 'maxClipDurationSeconds', label: 'Max clip duration (s)', kind: 'number' },
  { key: 'language', label: 'Language', kind: 'text', helper: 'e.g. en, hi' },
];

type PrefDraft = Record<keyof StreamerPreferencesInput, string>;

const emptyPrefs = (): PrefDraft => ({ maxClipsPerStream: '', minHighlightScore: '', minClipDurationSeconds: '', maxClipDurationSeconds: '', language: '' });

function toPrefs(d: PrefDraft): StreamerPreferencesInput {
  const out: Record<string, number | string | null> = {};
  for (const f of PREF_FIELDS) {
    const raw = d[f.key].trim();
    out[f.key] = raw === '' ? null : f.kind === 'number' ? Number(raw) : raw;
  }
  return out as StreamerPreferencesInput;
}

const parseTags = (raw: string) =>
  [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))];

interface StreamerFormDialogProps {
  open: boolean;
  /** Edit mode when provided. */
  streamer?: StreamerDTO | null;
  onClose: () => void;
  onSaved?: (s: StreamerDTO) => void;
}

export function StreamerFormDialog({ open, streamer, onClose, onSaved }: StreamerFormDialogProps) {
  const editing = Boolean(streamer);
  const create = useCreateStreamer();
  const update = useUpdateStreamer();
  const mutation = editing ? update : create;

  const [channel, setChannel] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tags, setTags] = useState('');
  const [category, setCategory] = useState('');
  const [monitoring, setMonitoring] = useState(true);
  const [prefs, setPrefs] = useState<PrefDraft>(emptyPrefs);

  useEffect(() => {
    if (!open) return;
    create.reset();
    update.reset();
    setChannel('');
    setDisplayName(streamer?.displayName ?? '');
    setTags(streamer?.tags.join(', ') ?? '');
    setCategory(streamer?.category ?? '');
    setMonitoring(streamer?.monitoringEnabled ?? true);
    const p = emptyPrefs();
    if (streamer) for (const f of PREF_FIELDS) p[f.key] = streamer.preferences[f.key]?.toString() ?? '';
    setPrefs(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, streamer]);

  const hasPrefs = Object.values(prefs).some((v) => v.trim() !== '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const done = { onSuccess: (s: StreamerDTO) => (onSaved?.(s), onClose()) };
    if (streamer) {
      update.mutate(
        {
          id: streamer.id,
          patch: { displayName: displayName.trim() || streamer.displayName, tags: parseTags(tags), category: category.trim() || null, preferences: toPrefs(prefs) },
        },
        done,
      );
    } else {
      create.mutate(
        {
          channel: channel.trim(),
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          tags: parseTags(tags),
          category: category.trim() || null,
          monitoringEnabled: monitoring,
          ...(hasPrefs ? { preferences: toPrefs(prefs) } : {}),
        },
        done,
      );
    }
  };

  const duplicateId =
    mutation.error instanceof ApiError && mutation.error.code === 'DUPLICATE_CHANNEL'
      ? (mutation.error.details as { streamerId?: string } | undefined)?.streamerId
      : undefined;

  return (
    <Dialog open={open} onClose={mutation.isPending ? undefined : onClose} maxWidth="sm" fullWidth component="form" onSubmit={submit}>
      <DialogTitle>{editing ? `Edit ${streamer!.displayName}` : 'Add streamer'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {mutation.isError && (
            <Alert
              severity="error"
              action={
                duplicateId ? (
                  <Button color="inherit" size="small" component={RouterLink} to={`/streamers/${duplicateId}`} onClick={onClose}>
                    View
                  </Button>
                ) : undefined
              }
            >
              {describeError(mutation.error)}
            </Alert>
          )}
          {!editing && (
            <TextField
              label="YouTube channel"
              placeholder="https://www.youtube.com/@streamer"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              helperText="Channel URL, @handle, channel ID (UC…), or any video/live URL from the channel"
              required
              autoFocus
              fullWidth
            />
          )}
          <TextField
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            helperText={editing ? undefined : 'Optional. Defaults to the channel name on YouTube.'}
            fullWidth
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} helperText="Comma-separated" fullWidth />
            <TextField label="Category" value={category} onChange={(e) => setCategory(e.target.value)} helperText="e.g. Gaming, Podcast" fullWidth />
          </Stack>
          {!editing && (
            <FormControlLabel control={<Switch checked={monitoring} onChange={(e) => setMonitoring(e.target.checked)} />} label="Start monitoring immediately" />
          )}
          <Accordion variant="outlined" disableGutters defaultExpanded={editing && hasPrefs}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography variant="body2">Clip preferences for this channel {hasPrefs ? '(customised)' : '(using global defaults)'}</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Grid container spacing={2}>
                {PREF_FIELDS.map((f) => (
                  <Grid key={f.key} size={{ xs: 12, sm: 6 }}>
                    <TextField
                      size="small"
                      fullWidth
                      label={f.label}
                      type={f.kind === 'number' ? 'number' : 'text'}
                      value={prefs[f.key]}
                      placeholder="Default"
                      helperText={f.helper}
                      onChange={(e) => setPrefs((p) => ({ ...p, [f.key]: e.target.value }))}
                    />
                  </Grid>
                ))}
              </Grid>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="contained" disabled={mutation.isPending || (!editing && !channel.trim())}>
          {mutation.isPending ? (editing ? 'Saving…' : 'Resolving channel…') : editing ? 'Save' : 'Add streamer'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
