import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';
import { ComingSoon } from '../components/ComingSoon';
import { PageHeader } from '../components/PageHeader';

export function ClipStudioPage() {
  return (
    <>
      <PageHeader title="Clip Studio" subtitle="Review, edit and approve generated Shorts." />
      <ComingSoon
        phase={4}
        title="Clip review"
        items={[
          'Vertical preview player with highlight score and explanation',
          'Transcript excerpt and source timestamps',
          'Edit title, description and hashtags before publishing',
          'Approve, reject, regenerate and retry upload',
        ]}
      />
    </>
  );
}

export function NotFoundPage() {
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Typography variant="h5">Page not found</Typography>
      <Button component={RouterLink} to="/" variant="outlined">
        Back to dashboard
      </Button>
    </Stack>
  );
}
