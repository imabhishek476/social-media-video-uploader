import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { describeError } from '../api/client';
import { useImportSession } from '../api/hooks';

/** Register a broadcast the monitor missed, by YouTube URL. */
export function ImportSessionDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (sessionId: string) => void }) {
  const [url, setUrl] = useState('');
  const importer = useImportSession();
  const close = () => {
    setUrl('');
    importer.reset();
    onClose();
  };
  const submit = () =>
    importer.mutate(url, {
      onSuccess: ({ session }) => {
        close();
        onImported(session.id);
      },
    });

  return (
    <Dialog open={open} onClose={importer.isPending ? undefined : close} maxWidth="sm" fullWidth>
      <DialogTitle>Add a missed live</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Paste the YouTube link of a stream the app did not catch. It must be from a registered streamer. Ended streams start processing right away; a stream that is still live is tracked until it ends.
        </Typography>
        <TextField
          autoFocus
          fullWidth
          label="YouTube URL or video id"
          placeholder="https://www.youtube.com/watch?v=… or youtube.com/live/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && submit()}
          disabled={importer.isPending}
        />
        {importer.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {describeError(importer.error)}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
          The recording itself comes from the storage inbox (incoming/&lt;videoId&gt;.mp4 in your bucket) or the Upload button on the session.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={importer.isPending}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!url.trim() || importer.isPending}>
          {importer.isPending ? 'Adding…' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
