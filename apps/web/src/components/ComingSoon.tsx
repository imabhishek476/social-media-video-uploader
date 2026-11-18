import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import ConstructionOutlined from '@mui/icons-material/ConstructionOutlined';

/** Placeholder for screens delivered in later phases (spec §20). */
export function ComingSoon({ phase, title, items }: { phase: number; title: string; items: string[] }) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}>
      <ConstructionOutlined color="action" sx={{ fontSize: 40, mb: 1 }} />
      <Typography variant="h6" gutterBottom>
        {title}
      </Typography>
      <Chip label={`Planned for Phase ${phase}`} size="small" color="primary" variant="outlined" sx={{ mb: 2 }} />
      <Box component="ul" sx={{ textAlign: 'left', maxWidth: 520, mx: 'auto', color: 'text.secondary', pl: 3 }}>
        {items.map((item) => (
          <li key={item}>
            <Typography variant="body2">{item}</Typography>
          </li>
        ))}
      </Box>
    </Paper>
  );
}
