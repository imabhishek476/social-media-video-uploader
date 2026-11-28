import { useEffect, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { describeError } from '../../api/client';
import { useCategories, useUpdateCategory, type CategoryPreset } from '../../api/hooks';

const FOLLOW = '';
const STYLE = [
  [FOLLOW, 'Same as Settings'],
  ['AUTO', 'Auto (per moment)'],
  ['REACTION', 'Reaction'],
  ['GAMEPLAY', 'Gameplay'],
  ['CLEAN', 'Clean gameplay'],
  ['STORY', 'Story'],
] as const;
const CAPTIONS = [
  [FOLLOW, 'Same as Settings'],
  ['STREAMER', 'Streamer (yellow glow)'],
  ['HYPE', 'Hype'],
  ['BOUNCE', 'Bounce'],
  ['CLEAN', 'Clean'],
  ['CUSTOM', 'Custom (Settings fonts)'],
] as const;
const HOOK = [
  [FOLLOW, 'Same as Settings'],
  ['ALWAYS', 'Whole Short'],
  ['INTRO', 'First 4 seconds'],
  ['OFF', 'No hook'],
] as const;
const NAMES: Record<string, string> = Object.fromEntries([...STYLE, ...CAPTIONS, ...HOOK].filter(([v]) => v));

type Draft = Record<'shortStyle' | 'captionStyle' | 'hookOverlay' | 'minDurationSeconds' | 'defaultDurationSeconds' | 'maxDurationSeconds' | 'hashtags' | 'descriptionFooter', string> & { playlist: 'ON' | 'OFF' };

const toDraft = (p: CategoryPreset): Draft => ({
  shortStyle: p.shortStyle ?? '',
  captionStyle: p.captionStyle ?? '',
  hookOverlay: p.hookOverlay ?? '',
  minDurationSeconds: p.minDurationSeconds?.toString() ?? '',
  defaultDurationSeconds: p.defaultDurationSeconds?.toString() ?? '',
  maxDurationSeconds: p.maxDurationSeconds?.toString() ?? '',
  hashtags: p.hashtags ?? '',
  descriptionFooter: p.descriptionFooter ?? '',
  playlist: p.playlist,
});
const num = (v: string) => (v.trim() === '' ? null : Number(v));

/** One-line summary shown on the closed accordion. */
function summary(p: CategoryPreset): string[] {
  const out: string[] = [];
  if (p.shortStyle) out.push(NAMES[p.shortStyle] ?? p.shortStyle);
  if (p.captionStyle) out.push(`${NAMES[p.captionStyle] ?? p.captionStyle} captions`);
  if (p.hookOverlay === 'OFF') out.push('no hook');
  if (p.defaultDurationSeconds) out.push(`~${p.defaultDurationSeconds} s`);
  if (p.playlist === 'ON') out.push('playlist');
  return out;
}

/** Phase 10: a preset per content category. Blank fields follow the other Settings tabs. */
export function CategoryPresets({ canEdit }: { canEdit: boolean }) {
  const q = useCategories();
  const [open, setOpen] = useState<string | false>('GAMING');
  if (q.isPending) return <Skeleton variant="rounded" height={320} sx={{ maxWidth: 860 }} />;
  if (q.isError) return <Alert severity="error">{describeError(q.error)}</Alert>;
  return (
    <Stack spacing={1.5} sx={{ maxWidth: 860 }}>
      <Alert severity="info" icon={false}>
        Each stream gets a category automatically (from the streamer, the game or the title). You can change it in Clip Studio. The category’s preset below decides how its Shorts look,
        how long they are, their hashtags, and which YouTube playlist they go to. Blank = same as the other Settings tabs.
      </Alert>
      {q.data.items.map((p) => (
        <Accordion key={p.category} variant="outlined" disableGutters expanded={open === p.category} onChange={(_, x) => setOpen(x ? p.category : false)} sx={{ '&:before': { display: 'none' }, borderRadius: 2 }}>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, width: '100%', pr: 1 }}>
              <Typography sx={{ fontWeight: 600, minWidth: 150 }}>{p.label}</Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                {summary(p).map((s) => (
                  <Chip key={s} size="small" variant="outlined" label={s} />
                ))}
                {!summary(p).length && (
                  <Typography variant="caption" color="text.secondary">
                    Same as Settings
                  </Typography>
                )}
              </Stack>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <PresetForm preset={p} canEdit={canEdit} />
          </AccordionDetails>
        </Accordion>
      ))}
    </Stack>
  );
}

function PresetForm({ preset, canEdit }: { preset: CategoryPreset; canEdit: boolean }) {
  const save = useUpdateCategory();
  const [d, setD] = useState<Draft>(() => toDraft(preset));
  useEffect(() => setD(toDraft(preset)), [preset]);
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(preset));
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  const select = (k: 'shortStyle' | 'captionStyle' | 'hookOverlay', label: string, options: ReadonlyArray<readonly [string, string]>) => (
    <TextField select fullWidth size="small" label={label} value={d[k]} onChange={set(k)} disabled={!canEdit} slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
      {options.map(([v, l]) => (
        <MenuItem key={v} value={v}>
          {l}
        </MenuItem>
      ))}
    </TextField>
  );
  const length = (k: 'minDurationSeconds' | 'defaultDurationSeconds' | 'maxDurationSeconds', label: string) => (
    <TextField fullWidth size="small" type="number" label={label} value={d[k]} onChange={set(k)} disabled={!canEdit} placeholder="Settings" slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: 5, max: 180 } }} helperText="seconds" />
  );
  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 4 }}>{select('shortStyle', 'Short style', STYLE)}</Grid>
        <Grid size={{ xs: 12, sm: 4 }}>{select('captionStyle', 'Captions', CAPTIONS)}</Grid>
        <Grid size={{ xs: 12, sm: 4 }}>{select('hookOverlay', 'Hook', HOOK)}</Grid>
        <Grid size={{ xs: 4 }}>{length('minDurationSeconds', 'Shortest')}</Grid>
        <Grid size={{ xs: 4 }}>{length('defaultDurationSeconds', 'Usually')}</Grid>
        <Grid size={{ xs: 4 }}>{length('maxDurationSeconds', 'Longest')}</Grid>
        <Grid size={12}>
          <TextField fullWidth size="small" label="Extra hashtags" value={d.hashtags} onChange={set('hashtags')} disabled={!canEdit} helperText="Added to your channel hashtags, comma-separated" slotProps={{ inputLabel: { shrink: true } }} />
        </Grid>
        <Grid size={12}>
          <TextField
            fullWidth
            size="small"
            multiline
            minRows={2}
            label="Description footer"
            value={d.descriptionFooter}
            onChange={set('descriptionFooter')}
            disabled={!canEdit}
            placeholder="Blank = the channel footer from Settings → YouTube"
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Grid>
      </Grid>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
        <FormControlLabel
          control={<Switch checked={d.playlist === 'ON'} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, playlist: e.target.checked ? 'ON' : 'OFF' }))} />}
          label={<Typography variant="body2">Add these Shorts to a “{preset.label} Shorts” playlist on YouTube</Typography>}
          sx={{ flexGrow: 1 }}
        />
        {preset.playlistId && (
          <Link href={`https://www.youtube.com/playlist?list=${preset.playlistId}`} target="_blank" rel="noreferrer" variant="body2">
            Open playlist
          </Link>
        )}
      </Stack>
      {save.isError && <Alert severity="error">{describeError(save.error)}</Alert>}
      {canEdit && (
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button disabled={!dirty || save.isPending} onClick={() => setD(toDraft(preset))}>
            Undo
          </Button>
          <Button
            variant="contained"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate({
                category: preset.category,
                input: {
                  shortStyle: d.shortStyle || null,
                  captionStyle: d.captionStyle || null,
                  hookOverlay: d.hookOverlay || null,
                  minDurationSeconds: num(d.minDurationSeconds),
                  defaultDurationSeconds: num(d.defaultDurationSeconds),
                  maxDurationSeconds: num(d.maxDurationSeconds),
                  hashtags: d.hashtags,
                  descriptionFooter: d.descriptionFooter,
                  playlist: d.playlist,
                },
              })
            }
          >
            {save.isPending ? 'Saving…' : `Save ${preset.label}`}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
