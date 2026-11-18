import { createTheme } from '@mui/material/styles';

/** Light/dark follow the OS preference via MUI CSS variables. */
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'media' },
  colorSchemes: {
    light: { palette: { primary: { main: '#d32f2f' }, background: { default: '#f6f7f9' } } },
    dark: { palette: { primary: { main: '#ff6b6b' }, background: { default: '#0f1115', paper: '#161a20' } } },
  },
  shape: { borderRadius: 10 },
  typography: { fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif', button: { textTransform: 'none', fontWeight: 600 } },
  components: {
    MuiCard: { defaultProps: { elevation: 0 } },
    MuiAppBar: { styleOverrides: { root: { backgroundImage: 'none' } } },
  },
});
