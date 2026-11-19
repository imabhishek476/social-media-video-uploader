import Chip, { type ChipProps } from '@mui/material/Chip';
import { humanize } from '../lib/format';

const COLOR_BY_STATUS: Record<string, ChipProps['color']> = {
  LIVE: 'error',
  OFFLINE: 'default',
  UNKNOWN: 'default',
  PENDING: 'default',
  NOT_STARTED: 'default',
  NOT_UPLOADED: 'default',
  QUEUED: 'info',
  RUNNING: 'info',
  RENDERING: 'info',
  UPLOADING: 'info',
  PROCESSING: 'info',
  DETECTED: 'info',
  RETRYING: 'warning',
  ENDED: 'warning',
  SOURCE_PENDING: 'warning',
  COMPLETED: 'success',
  RENDERED: 'success',
  PUBLISHED: 'success',
  APPROVED: 'success',
  AUTO_APPROVED: 'success',
  SOURCE_READY: 'success',
  HIGHLIGHTS_READY: 'success',
  SELECTED: 'success',
  CANDIDATE: 'info',
  DISCARDED: 'default',
  TRANSCRIBING: 'info',
  ANALYZING: 'info',
  FAILED: 'error',
  RENDER_FAILED: 'error',
  UPLOAD_FAILED: 'error',
  SOURCE_UNAVAILABLE: 'error',
  REJECTED: 'error',
  CANCELLED: 'default',
};

export function StatusChip({ status, size = 'small' }: { status: string; size?: ChipProps['size'] }) {
  return <Chip label={humanize(status)} color={COLOR_BY_STATUS[status] ?? 'default'} size={size} variant="outlined" />;
}
