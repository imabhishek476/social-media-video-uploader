import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value?: number;
  icon: ReactNode;
  tone?: 'default' | 'error' | 'success' | 'warning' | 'info';
}

export function StatCard({ label, value, icon, tone = 'default' }: StatCardProps) {
  const color = tone === 'default' ? 'text.secondary' : `${tone}.main`;
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color, mb: 1 }}>
          {icon}
          <Typography variant="body2" color="text.secondary">
            {label}
          </Typography>
        </Stack>
        {value === undefined ? (
          <Skeleton width={48} height={40} />
        ) : (
          <Typography variant="h4" component="p" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
