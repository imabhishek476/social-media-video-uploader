import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ScheduleDTO,
  AppSettingsDTO,
  CandidateUpdateInput,
  ClipMetadataInput,
  ClipMediaDTO,
  GeneratedClipDTO,
  CreateStreamerInput,
  HighlightCandidateDTO,
  SourcePreviewDTO,
  TranscriptDTO,
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
import { ApiError, api, uploadFile } from './client';

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
    mutationFn: (arg: string | { id: string; retranscribe?: boolean }) => {
      const { id, retranscribe } = typeof arg === 'string' ? { id: arg, retranscribe: false } : arg;
      return api<LiveSessionDTO>(`/live-sessions/${id}/reprocess`, { method: 'POST', body: { retranscribe: Boolean(retranscribe) } });
    },
    onSuccess: invalidate,
  });
}

export function useUploadSource() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: ({ id, file, onProgress }: { id: string; file: File; onProgress: (pct: number) => void }) =>
      uploadFile<LiveSessionDTO>(`/live-sessions/${id}/source`, file, onProgress),
    onSuccess: invalidate,
  });
}

// --- Clip Studio (Phase 4) ---------------------------------------------------

export function useHighlights(sessionId: string | null) {
  return useQuery({
    queryKey: ['highlights', sessionId],
    queryFn: async () => (await api<{ items: HighlightCandidateDTO[] }>(`/live-sessions/${sessionId}/highlights`)).items,
    enabled: Boolean(sessionId),
  });
}

export function useTranscript(sessionId: string | null) {
  return useQuery({
    queryKey: ['transcript', sessionId],
    queryFn: () => api<TranscriptDTO>(`/live-sessions/${sessionId}/transcript`),
    enabled: Boolean(sessionId),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
    staleTime: 5 * 60_000,
  });
}

export function useSourcePreview(sessionId: string | null) {
  return useQuery({
    queryKey: ['source-preview', sessionId],
    queryFn: () => api<SourcePreviewDTO>(`/live-sessions/${sessionId}/source/preview`),
    enabled: Boolean(sessionId),
    retry: false,
    // Signed URLs last 2 hours; refresh well before.
    staleTime: 60 * 60_000,
  });
}

export function useUpdateHighlight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CandidateUpdateInput }) => api<HighlightCandidateDTO>(`/highlights/${id}`, { method: 'PATCH', body: input }),
    onSuccess: (updated) => {
      qc.setQueryData<HighlightCandidateDTO[]>(['highlights', updated.liveSessionId], (old) => old?.map((c) => (c.id === updated.id ? updated : c)));
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

// --- Rendered Shorts (Phase 5) ------------------------------------------------

/** Polls while the session is rendering or any clip is still in progress. */
export function useClips(sessionId: string | null, sessionRendering: boolean) {
  return useQuery({
    queryKey: ['clips', sessionId],
    queryFn: async () => (await api<{ items: GeneratedClipDTO[] }>(`/live-sessions/${sessionId}/clips`)).items,
    enabled: Boolean(sessionId),
    refetchInterval: (q) =>
      sessionRendering || (q.state.data ?? []).some((c) => ['RENDERING', 'PENDING'].includes(c.renderStatus) || ['QUEUED', 'UPLOADING'].includes(c.uploadStatus) || (c.renderStatus === 'RENDERED' && !c.title && !c.lastError))
        ? 4000
        : false,
  });
}

export function useClipMedia(clipId: string | null, version: number | null) {
  return useQuery({
    queryKey: ['clip-media', clipId, version],
    queryFn: () => api<ClipMediaDTO>(`/clips/${clipId}/media`),
    enabled: Boolean(clipId),
    staleTime: 60 * 60_000,
    retry: false,
  });
}

export function useRenderSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, force, fresh, reframingMode, shortStyle }: { sessionId: string; force?: boolean; fresh?: boolean; reframingMode?: string; shortStyle?: string }) =>
      api<{ queued: boolean; removed?: number; kept?: number }>(`/live-sessions/${sessionId}/render`, {
        method: 'POST',
        body: { force: Boolean(force), ...(fresh ? { fresh: true } : {}), ...(reframingMode ? { reframingMode } : {}), ...(shortStyle ? { shortStyle } : {}) },
      }),
    onSuccess: (_d, { sessionId }) => {
      void qc.invalidateQueries({ queryKey: ['clips', sessionId] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

// --- Publishing (Phase 6) -----------------------------------------------------

export function useConnectYouTube() {
  return useMutation({
    mutationFn: () => api<{ url: string }>('/integrations/youtube/connect'),
    // Full-page redirect to Google's consent screen.
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function useDisconnectYouTube() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/integrations/youtube', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

function useClipMutation<V>(fn: (v: V) => Promise<GeneratedClipDTO>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (clip) => {
      qc.setQueryData<GeneratedClipDTO[]>(['clips', clip.liveSessionId], (old) => old?.map((c) => (c.id === clip.id ? clip : c)));
      void qc.invalidateQueries({ queryKey: ['clips', clip.liveSessionId] });
      void qc.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export const useUpdateClipMetadata = () =>
  useClipMutation(({ id, input }: { id: string; input: ClipMetadataInput }) => api<GeneratedClipDTO>(`/clips/${id}`, { method: 'PATCH', body: input }));
export const useRegenerateMetadata = () => useClipMutation((id: string) => api<GeneratedClipDTO>(`/clips/${id}/metadata`, { method: 'POST', body: {} }));
export const useApproveClip = () => useClipMutation((id: string) => api<GeneratedClipDTO>(`/clips/${id}/approve`, { method: 'POST', body: {} }));
export const useRejectClip = () => useClipMutation((id: string) => api<GeneratedClipDTO>(`/clips/${id}/reject`, { method: 'POST', body: {} }));

export function useImportSession() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: (url: string) => api<{ session: LiveSessionDTO; created: boolean }>('/live-sessions/import', { method: 'POST', body: { url } }),
    onSuccess: invalidate,
  });
}

/** Manual facecam box for the split layout; `null` = detect again on the next render. */
export function useSetFacecam() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: ({ id, box }: { id: string; box: { x: number; y: number; w: number; h: number } | null }) =>
      api<LiveSessionDTO>(`/live-sessions/${id}/facecam`, { method: 'PUT', body: { box } }),
    onSuccess: invalidate,
  });
}

export function useConnectInstagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accessToken: string) => api<unknown>('/integrations/instagram', { method: 'PUT', body: { accessToken } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

export function useDisconnectInstagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/integrations/instagram', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

export const usePostToInstagram = () => useClipMutation((id: string) => api<GeneratedClipDTO>(`/clips/${id}/instagram`, { method: 'POST', body: {} }));

/** Permanently delete a session with its recording, transcript, highlights and Shorts. */
export function useDeleteSession() {
  const invalidate = useInvalidateLive();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/live-sessions/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

// Phase 8: publish calendar
export function useSchedule(days = 14) {
  return useQuery({ queryKey: ['schedule', days], queryFn: () => api<ScheduleDTO>('/schedule', { query: { days } }), refetchInterval: 30_000 });
}

export function useRescheduleClip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clipId, goLiveAt }: { clipId: string; goLiveAt: string }) => api<{ ok: boolean }>(`/clips/${clipId}/schedule`, { method: 'PUT', body: { goLiveAt } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedule'] }),
  });
}

export function usePublishNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clipId }: { clipId: string }) => api<{ ok: boolean }>(`/clips/${clipId}/publish-now`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedule'] });
      void qc.invalidateQueries({ queryKey: ['clips'] });
    },
  });
}

// Phase 8.5: weekly compilations
export interface CompilationSummary {
  id: string;
  weekKey: string;
  status: string;
  title: string;
  clipCount: number;
  durationSeconds: number | null;
  youtubeUrl: string | null;
  lastError: string | null;
  createdAt: string;
}

export function useCompilations() {
  return useQuery({ queryKey: ['compilations'], queryFn: () => api<{ items: CompilationSummary[] }>('/compilations'), refetchInterval: 20_000 });
}

export function useBuildCompilation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ queued: boolean }>('/compilations/build', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['compilations'] }),
  });
}

// --- Autopilot (Phase 9) ------------------------------------------------------

export interface AutopilotStatus {
  enabled: boolean;
  paused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  consecutiveFailures: number;
  minScore: number;
  today: { published: number; held: number };
}
export interface AutopilotEvent {
  id: string;
  kind: 'PUBLISHED' | 'HELD' | 'PAUSED' | 'RESUMED';
  clipId: string | null;
  liveSessionId: string | null;
  title: string;
  score: number | null;
  reasons: string[];
  by: string;
  createdAt: string;
}

export function useAutopilot() {
  return useQuery({ queryKey: ['autopilot'], queryFn: () => api<{ status: AutopilotStatus; events: AutopilotEvent[] }>('/autopilot?limit=200'), refetchInterval: 15_000 });
}

export function useAutopilotSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'pause' | 'resume') => api<AutopilotStatus>(`/autopilot/${action}`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['autopilot'] }),
  });
}

// --- Categories and presets (Phase 10) ----------------------------------------

export interface CategoryPreset {
  category: string;
  label: string;
  shortStyle: string | null;
  captionStyle: string | null;
  hookOverlay: string | null;
  minDurationSeconds: number | null;
  defaultDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  hashtags: string | null;
  descriptionFooter: string | null;
  playlist: 'ON' | 'OFF';
  playlistId: string | null;
}
export interface CategoryStat {
  category: string;
  label: string;
  shorts: number;
  views: number;
  likes: number;
  avgViewPercent: number | null;
  subscribers: number;
}

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => api<{ items: CategoryPreset[] }>('/categories') });
}
export function useCategoryStats() {
  return useQuery({ queryKey: ['categories', 'stats'], queryFn: () => api<{ items: CategoryStat[] }>('/categories/stats'), refetchInterval: 60_000 });
}
export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ category, input }: { category: string; input: Partial<CategoryPreset> }) => api<CategoryPreset>(`/categories/${category}`, { method: 'PUT', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['categories'] }),
  });
}
export function useSetSessionCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, category }: { sessionId: string; category: string }) => api<{ category: string }>(`/sessions/${sessionId}/category`, { method: 'PUT', body: { category } }),
    onSuccess: (_d, v) => void qc.invalidateQueries({ queryKey: ['sessions', 'detail', v.sessionId] }),
  });
}
