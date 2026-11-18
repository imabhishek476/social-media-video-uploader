import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { describeError } from '../api/client';
import { useMe } from '../api/hooks';

export function RequireAuth() {
  const { data: user, isPending, isError, error, refetch, isFetching } = useMe();
  const location = useLocation();

  if (isPending) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }
  // Only a definitive 401 (useMe → null) means "signed out". A network or
  // server error must not bounce the user to the login page.
  if (isError) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh', p: 2 }}>
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => refetch()} disabled={isFetching}>
              Retry
            </Button>
          }
        >
          Can’t reach the API right now: {describeError(error)}
        </Alert>
      </Box>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
