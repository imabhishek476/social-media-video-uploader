import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Snackbar from '@mui/material/Snackbar';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import EditOutlined from '@mui/icons-material/EditOutlined';
import MoreVert from '@mui/icons-material/MoreVert';
import PauseCircleOutline from '@mui/icons-material/PauseCircleOutline';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import Refresh from '@mui/icons-material/Refresh';
import SensorsOutlined from '@mui/icons-material/SensorsOutlined';
import SensorsOffOutlined from '@mui/icons-material/SensorsOffOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import WifiOffOutlined from '@mui/icons-material/WifiOffOutlined';
import type { StreamerDTO } from '@shorts/shared-types';
import { describeError } from '../api/client';
import { useCheckNow, useRemoveStreamer, useSetMonitoring } from '../api/hooks';
import { ConfirmDialog } from './ConfirmDialog';

interface StreamerActionsProps {
  streamer: StreamerDTO;
  canEdit: boolean;
  showView?: boolean;
  onEdit: () => void;
  onRemoved?: () => void;
}

/** Row/page action menu: view, edit, check now, pause/resume, remove. */
export function StreamerActions({ streamer, canEdit, showView = true, onEdit, onRemoved }: StreamerActionsProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const navigate = useNavigate();
  const setMonitoring = useSetMonitoring();
  const checkNow = useCheckNow();
  const remove = useRemoveStreamer();

  const close = () => setAnchor(null);
  const run = (fn: () => Promise<unknown>, success: string) => {
    close();
    fn().then(
      () => setToast(success),
      (err) => setToast(describeError(err)),
    );
  };
  const isLive = streamer.liveStatus === 'LIVE';

  return (
    <>
      <IconButton
        aria-label={`Actions for ${streamer.displayName}`}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(e.currentTarget);
        }}
      >
        <MoreVert />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={close} onClick={(e) => e.stopPropagation()}>
        {showView && (
          <MenuItem onClick={() => (close(), navigate(`/streamers/${streamer.id}`))}>
            <ListItemIcon>
              <VisibilityOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>View</ListItemText>
          </MenuItem>
        )}
        {canEdit && [
          <MenuItem key="edit" onClick={() => (close(), onEdit())}>
            <ListItemIcon>
              <EditOutlined fontSize="small" />
            </ListItemIcon>
            <ListItemText>Edit</ListItemText>
          </MenuItem>,
          <MenuItem key="check" disabled={!streamer.monitoringEnabled} onClick={() => run(() => checkNow.mutateAsync(streamer.id), 'Check scheduled — results within ~15 seconds')}>
            <ListItemIcon>
              <Refresh fontSize="small" />
            </ListItemIcon>
            <ListItemText>Check now</ListItemText>
          </MenuItem>,
          <MenuItem
            key="monitoring"
            onClick={() =>
              run(
                () => setMonitoring.mutateAsync({ id: streamer.id, enabled: !streamer.monitoringEnabled }),
                streamer.monitoringEnabled ? 'Monitoring paused' : 'Monitoring resumed',
              )
            }
          >
            <ListItemIcon>{streamer.monitoringEnabled ? <PauseCircleOutline fontSize="small" /> : <PlayCircleOutline fontSize="small" />}</ListItemIcon>
            <ListItemText>{streamer.monitoringEnabled ? 'Pause monitoring' : 'Resume monitoring'}</ListItemText>
          </MenuItem>,
        ]}
        {canEdit && [
          <Divider key="d2" />,
          <MenuItem key="remove" onClick={() => (close(), setConfirmRemove(true))} sx={{ color: 'error.main' }}>
            <ListItemIcon>
              <DeleteOutline fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText>Delete</ListItemText>
          </MenuItem>,
        ]}
      </Menu>

      <ConfirmDialog
        open={confirmRemove}
        title={`Delete ${streamer.displayName} permanently?`}
        body={
          <>
            This deletes the channel and <strong>everything from it</strong>: all sessions, recordings, transcripts, highlights and rendered Shorts, including the files in storage. It cannot be undone.
            {isLive && <strong> The broadcast in progress is stopped and not processed.</strong>} Shorts already published on YouTube or Instagram stay there.
          </>
        }
        confirmLabel="Delete everything"
        danger
        busy={remove.isPending}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() =>
          remove.mutate(streamer.id, {
            onSuccess: () => {
              setConfirmRemove(false);
              onRemoved?.();
            },
            onError: (err) => (setConfirmRemove(false), setToast(describeError(err))),
          })
        }
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast(null)} message={toast} />
    </>
  );
}
