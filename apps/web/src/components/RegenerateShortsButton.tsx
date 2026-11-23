import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Refresh from '@mui/icons-material/Refresh';
import { describeError } from '../api/client';
import { useRenderSession } from '../api/hooks';

const LAYOUTS = [
  { value: 'FACECAM_SPLIT', label: 'Split: webcam on top, gameplay below' },
  { value: 'GAMEPLAY', label: 'Gameplay full screen, small webcam corner' },
  { value: 'BLUR_FIT', label: 'Whole frame over a blurred background' },
  { value: 'CENTER_CROP', label: 'Centre crop' },
];

/**
 * Deletes the session's unpublished Shorts (videos, thumbnails, captions,
 * titles) and renders them again from the selected highlights in the chosen
 * layout. Shorts already posted are kept.
 */
export function RegenerateShortsButton({ sessionId, currentMode, unpublished, disabled }: { sessionId: string; currentMode: string; unpublished: number; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(currentMode);
  const render = useRenderSession();
  const submit = () =>
    render.mutate({ sessionId, fresh: true, reframingMode: mode }, { onSuccess: () => setOpen(false) });
  return (
    <>
      <Button size="small" variant="outlined" color="warning" startIcon={<Refresh />} disabled={disabled} onClick={() => { setMode(currentMode); setOpen(true); }}>
        Regenerate…
      </Button>
      <Dialog open={open} onClose={() => !render.isPending && setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Regenerate Shorts</DialogTitle>
        <DialogContent>
          <TextField select fullWidth label="Layout" value={mode} onChange={(e) => setMode(e.target.value)} sx={{ mt: 1, mb: 2 }}>
            {LAYOUTS.map((l) => (
              <MenuItem key={l.value} value={l.value}>
                {l.label}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="body2" color="text.secondary">
            Deletes {unpublished} unpublished Short{unpublished === 1 ? '' : 's'} of this session (videos, thumbnails, captions, titles) and renders new ones from the
            selected highlights. Shorts already on YouTube or Instagram are kept. This can’t be undone.
          </Typography>
          {render.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {describeError(render.error)}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={render.isPending}>
            Cancel
          </Button>
          <Button variant="contained" color="warning" onClick={submit} disabled={render.isPending}>
            Delete & regenerate
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
