import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { InstagramConnectionDTO } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useConnectInstagram, useDisconnectInstagram } from '../api/hooks';
import { formatDateTime } from '../lib/format';

/** Connect the Instagram Business/Creator account by pasting a long-lived token. */
export function InstagramCard({ ig, canEdit }: { ig: InstagramConnectionDTO | undefined; canEdit: boolean }) {
  const connect = useConnectInstagram();
  const disconnect = useDisconnectInstagram();
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  if (!ig) return null;
  const showForm = canEdit && (!ig.connected || editing);

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardHeader
        title="Instagram Reels"
        subheader="Cross-post Shorts as Reels to your Business/Creator account."
        action={<Chip size="small" color={ig.connected ? 'success' : ig.status === 'ERROR' ? 'error' : 'default'} label={ig.connected ? 'Connected' : ig.status === 'ERROR' ? 'Needs reconnect' : 'Not connected'} />}
        slotProps={{ title: { variant: 'subtitle1', sx: { fontWeight: 600 } } }}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={1.5}>
          {ig.username && (
            <Typography variant="body2">
              @{ig.username} · token valid until {formatDateTime(ig.tokenExpiresAt)} (renewed automatically)
            </Typography>
          )}
          {ig.status === 'ERROR' && ig.lastError && <Alert severity="error">{ig.lastError}</Alert>}
          {showForm && (
            <>
              <TextField
                size="small"
                type="password"
                label="Instagram access token"
                value={token}
                autoComplete="off"
                helperText="Instagram Login token (IG…: instagram_business_basic + instagram_business_content_publish) or Facebook Login token (EAA…: instagram_basic, instagram_content_publish, pages_show_list, pages_read_engagement). Stored encrypted."
                onChange={(e) => setToken(e.target.value)}
              />
              <Stack direction="row" spacing={1}>
                <Button
                  variant="contained"
                  disabled={token.trim().length < 20 || connect.isPending}
                  onClick={() =>
                    connect.mutate(token, {
                      onSuccess: () => {
                        setToken('');
                        setEditing(false);
                      },
                    })
                  }
                >
                  {connect.isPending ? 'Checking…' : 'Connect Instagram'}
                </Button>
                {editing && <Button onClick={() => setEditing(false)}>Cancel</Button>}
              </Stack>
            </>
          )}
          {canEdit && ig.connected && !editing && (
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={() => setEditing(true)}>
                Replace token
              </Button>
              <Button color="error" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            </Stack>
          )}
          {(connect.isError || disconnect.isError) && <Alert severity="error">{describeError(connect.error ?? disconnect.error)}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}
