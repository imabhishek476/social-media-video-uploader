import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppSettingsDTO,
  CreateStreamerInput,
  LiveSessionDTO,
  LiveStatus,
  SessionStatus,
  StreamerDTO,
  UpdateStreamerInput,
  DashboardSummaryDTO,
  JobStatus,
  JobType,
  LoginInput,
  Paginated,
  ProcessingJobDTO,
  SettingsUpdateInput,
  SystemStatusDTO,
  UserDTO,
} from '@shorts/shared-types';
import { ApiError, api } from './client';

/** All server state lives in React Query; components only call these hooks. */

export const queryKeys = {
  me: ['auth', 'me'] as const,
  dashboard: ['dashboard', 'summary'] as const,
  system: ['system', 'status'] as const,
  jobs: (filters: object) => ['jobs', filters] as const,
  settings: ['settings'] as const,
};

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      try {
        return (await api<{ user: UserDTO }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60 * 1000,
    // 401 resolves to null above; retry transient failures (e.g. API restarting).
    retry: 3,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api<{ user: UserDTO }>('/auth/login', { method: 'POST', body: input }),
    onSuccess: ({ user }) => qc.setQueryData(queryKeys.me, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(queryKeys.me, null);
    },
  });
}

export function useDashboardSummary() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => api<DashboardSummaryDTO>('/dashboard/summary'),
    refetchInterval: 15_000,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: queryKeys.system,
    queryFn: () => api<SystemStatusDTO>('/system/status'),
    refetchInterval: 10_000,
  });
}

export interface JobFilters {
  page: number;
  pageSize: number;
  status?: JobStatus;
  jobType?: JobType;
}

export function useJobs(filters: JobFilters) {
  return useQuery({
    queryKey: queryKeys.jobs(filters),
    queryFn: () => api<Paginated<ProcessingJobDTO>>('/jobs', { query: { ...filters } }),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: () => api<AppSettingsDTO>('/settings') });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsUpdateInput) => api<AppSettingsDTO>('/settings', { method: 'PATCH', body: patch }),
    onSuccess: (data) => qc.setQueryData(queryKeys.settings, data),
  });
}

// ---------------------------------------------------------------------------
// Streamers & live sessions
// ---------------------------------------------------------------------------

export interface StreamerFilters {
  page: number;
  pageSize: number;
  search?: string;
  liveStatus?: LiveStatus;
  monitoring?: 'enabled' | 'paused';
}

export interface SessionFilters {
  page: number;
  pageSize: number;
  status?: SessionStatus;
  streamerId?: string;
}

/** After any streamer/session change, refresh everything that shows them. */
function useInvalidateLive() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['streamers'] }),
      qc.invalidateQueries({ queryKey: ['sessions'] }),
      qc.invalidateQueries({ queryKey: queryKeys.dashboard }),
      qc.invalidateQueries({ queryKey: ['jobs'] }),
    ]);
}

export function useStreamers(filters: StreamerFilters) {
  return useQuery({
    queryKey: ['streamers', 'list', filters],
    queryFn: () => api<Paginated<StreamerDTO>>('/streamers', { query: { ...filters } }),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
}

export function useStreamer(id: string | undefined) {
  return useQuery({
    queryKey: ['streamers', 'detail', id],
    queryFn: () => api<StreamerDTO>(`/streamers/${id}`),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });
}

export function useCreateStreamer() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: (input: CreateStreamerInput) => api<StreamerDTO>('/streamers', { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateStreamer() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateStreamerInput }) => api<StreamerDTO>(`/streamers/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: invalidate,
  });
}

export function useSetMonitoring() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<StreamerDTO>(`/streamers/${id}/monitoring`, { method: 'PATCH', body: { enabled } }),
    onSuccess: invalidate,
  });
}

export function useCheckNow() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: (id: string) => api<StreamerDTO>(`/streamers/${id}/check`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useRemoveStreamer() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/streamers/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useSessions(filters: SessionFilters) {
  return useQuery({
    queryKey: ['sessions', 'list', filters],
    queryFn: () => api<Paginated<LiveSessionDTO>>('/live-sessions', { query: { ...filters } }),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api<LiveSessionDTO>(`/live-sessions/${id}`),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });
}

export function useReprocessSession() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: (id: string) => api<LiveSessionDTO>(`/live-sessions/${id}/reprocess`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

/** Dev-only: drive the mock YouTube provider. */
export function useMockLiveControl() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: ({ channelId, action, mode }: { channelId: string; action: 'go-live' | 'end-live'; mode?: 'clean' | 'ambiguous' | 'vanish' }) =>
      api<{ videoId: string }>(`/dev/mock-youtube/channels/${channelId}/${action}`, { method: 'POST', body: action === 'end-live' ? { mode } : {} }),
    onSuccess: invalidate,
  });
}
