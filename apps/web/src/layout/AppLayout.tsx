import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import LiveTvOutlined from '@mui/icons-material/LiveTvOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import MovieFilterOutlined from '@mui/icons-material/MovieFilterOutlined';
import PeopleAltOutlined from '@mui/icons-material/PeopleAltOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import WorkHistoryOutlined from '@mui/icons-material/WorkHistoryOutlined';
import EventOutlined from '@mui/icons-material/EventOutlined';
import SmartToyOutlined from '@mui/icons-material/SmartToyOutlined';
import { useLogout, useMe } from '../api/hooks';

const DRAWER_WIDTH = 240;

const NAV: Array<{ to: string; label: string; icon: ReactNode }> = [
  { to: '/', label: 'Dashboard', icon: <DashboardOutlined /> },
  { to: '/streamers', label: 'Streamers', icon: <PeopleAltOutlined /> },
  { to: '/sessions', label: 'Live Sessions', icon: <LiveTvOutlined /> },
  { to: '/clips', label: 'Clip Studio', icon: <MovieFilterOutlined /> },
  { to: '/schedule', label: 'Schedule', icon: <EventOutlined /> },
  { to: '/autopilot', label: 'Autopilot', icon: <SmartToyOutlined /> },
  { to: '/jobs', label: 'Job Monitor', icon: <WorkHistoryOutlined /> },
  { to: '/settings', label: 'Settings', icon: <SettingsOutlined /> },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <List sx={{ px: 1 }}>
      {NAV.map((item) => (
        <ListItemButton
          key={item.to}
          component={NavLink}
          to={item.to}
          end={item.to === '/'}
          onClick={onNavigate}
          sx={{ borderRadius: 2, mb: 0.5, '&.active': { bgcolor: 'action.selected', '& .MuiListItemIcon-root': { color: 'primary.main' } } }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
          <ListItemText primary={item.label} />
        </ListItemButton>
      ))}
    </List>
  );
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();

  const brand = (
    <Toolbar sx={{ gap: 1 }}>
      <Box component="img" src="/favicon.svg" alt="" sx={{ width: 22, height: 22 }} />
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
        AI Shorts Studio
      </Typography>
    </Toolbar>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{ width: { md: `calc(100% - ${DRAWER_WIDTH}px)` }, ml: { md: `${DRAWER_WIDTH}px` }, borderBottom: 1, borderColor: 'divider' }}
      >
        <Toolbar>
          <IconButton edge="start" onClick={() => setMobileOpen(true)} sx={{ mr: 1, display: { md: 'none' } }} aria-label="Open navigation">
            <MenuIcon />
          </IconButton>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={user?.email ?? ''}>
            <IconButton onClick={(e) => setAnchor(e.currentTarget)} aria-label="Account menu">
              <Avatar sx={{ width: 32, height: 32, fontSize: 14, bgcolor: 'primary.main' }}>
                {(user?.name ?? '?').slice(0, 1).toUpperCase()}
              </Avatar>
            </IconButton>
          </Tooltip>
          <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
            <MenuItem disabled>
              <ListItemText primary={user?.name} secondary={`${user?.email ?? ''} · ${user?.role ?? ''}`} />
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => {
                setAnchor(null);
                logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) });
              }}
            >
              Sign out
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}
        >
          {brand}
          <NavList onNavigate={() => setMobileOpen(false)} />
        </Drawer>
        <Drawer variant="permanent" open sx={{ display: { xs: 'none', md: 'block' }, '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}>
          {brand}
          <NavList />
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, md: 4 } }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
