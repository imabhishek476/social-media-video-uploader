import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { AppLayout } from './layout/AppLayout';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { LoginPage } from './pages/LoginPage';
import { LiveSessionsPage } from './pages/LiveSessionsPage';
import { ClipStudioPage } from './pages/ClipStudioPage';
import { NotFoundPage } from './pages/PlaceholderPages';
import { StreamerDetailPage } from './pages/StreamerDetailPage';
import { StreamersPage } from './pages/StreamersPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="streamers" element={<StreamersPage />} />
          <Route path="streamers/:id" element={<StreamerDetailPage />} />
          <Route path="sessions" element={<LiveSessionsPage />} />
          <Route path="clips" element={<ClipStudioPage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
