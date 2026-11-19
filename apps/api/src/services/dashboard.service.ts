import { GeneratedClipModel, LiveSessionModel, ProcessingJobModel, StreamerChannelModel } from '@shorts/database';
import { monthToDateSpendUsd, type SettingsService } from '@shorts/core';
import {
  JobStatus,
  LiveStatus,
  RenderStatus,
  SessionStatus,
  UploadStatus,
  type ApprovalStatus,
  type ClipSummaryDTO,
  type DashboardSummaryDTO,
  type LiveSessionSummaryDTO,
  type ProcessingStatus,
} from '@shorts/shared-types';

const WAITING_STATES = [SessionStatus.ENDED, SessionStatus.SOURCE_PENDING, SessionStatus.SOURCE_READY];

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const streamerName = (ref: unknown) =>
  ref && typeof ref === 'object' && 'displayName' in ref ? String((ref as { displayName: string }).displayName) : 'Unknown';

type PopulatedClip = {
  _id: unknown;
  title: string;
  streamerChannelId: unknown;
  durationSeconds: number;
  renderStatus: string;
  approvalStatus: string;
  uploadStatus: string;
  youtubeUrl?: string | null;
  createdAt: Date;
  publishedAt?: Date | null;
  liveSessionId: unknown;
  stats?: { views?: number; likes?: number } | null;
};

function toClipSummary(c: PopulatedClip): ClipSummaryDTO {
  return {
    id: String(c._id),
    title: c.title,
    streamerName: streamerName(c.streamerChannelId),
    durationSeconds: c.durationSeconds,
    renderStatus: c.renderStatus as RenderStatus,
    approvalStatus: c.approvalStatus as ApprovalStatus,
    uploadStatus: c.uploadStatus as UploadStatus,
    youtubeUrl: c.youtubeUrl ?? null,
    createdAt: c.createdAt.toISOString(),
    publishedAt: iso(c.publishedAt),
    liveSessionId: String(c.liveSessionId),
    views: c.stats?.views ?? null,
    likes: c.stats?.likes ?? null,
  };
}

export async function getDashboardSummary(settings: SettingsService): Promise<DashboardSummaryDTO> {
  const today = startOfToday();
  const [
    streamers,
    liveStreamers,
    sessionsWaiting,
    sessionsProcessing,
    shortsGeneratedToday,
    shortsPublishedToday,
    failedJobs,
    sessions,
    clips,
    uploads,
    awaitingReview,
    queuedUploads,
    spentUsd,
    values,
    top,
  ] = await Promise.all([
    StreamerChannelModel.countDocuments(),
    StreamerChannelModel.countDocuments({ liveStatus: LiveStatus.LIVE }),
    LiveSessionModel.countDocuments({ status: { $in: WAITING_STATES } }),
    LiveSessionModel.countDocuments({ status: SessionStatus.PROCESSING }),
    GeneratedClipModel.countDocuments({ renderStatus: RenderStatus.RENDERED, createdAt: { $gte: today } }),
    GeneratedClipModel.countDocuments({ uploadStatus: UploadStatus.PUBLISHED, publishedAt: { $gte: today } }),
    ProcessingJobModel.countDocuments({ status: JobStatus.FAILED }),
    LiveSessionModel.find().sort({ createdAt: -1 }).limit(5).populate('streamerChannelId', 'displayName').lean(),
    GeneratedClipModel.find().sort({ createdAt: -1 }).limit(5).populate('streamerChannelId', 'displayName').lean(),
    GeneratedClipModel.find({ uploadStatus: UploadStatus.PUBLISHED })
      .sort({ publishedAt: -1 })
      .limit(5)
      .populate('streamerChannelId', 'displayName')
      .lean(),
    GeneratedClipModel.countDocuments({ renderStatus: RenderStatus.RENDERED, approvalStatus: 'PENDING', title: { $ne: '' }, filesExpiredAt: null }),
    GeneratedClipModel.countDocuments({ uploadStatus: { $in: [UploadStatus.QUEUED, UploadStatus.UPLOADING] } }),
    monthToDateSpendUsd(),
    settings.getValues(),
    GeneratedClipModel.find({ uploadStatus: UploadStatus.PUBLISHED, 'stats.views': { $gt: 0 } })
      .sort({ 'stats.views': -1 })
      .limit(5)
      .populate('streamerChannelId', 'displayName')
      .lean(),
  ]);

  const recentSessions: LiveSessionSummaryDTO[] = sessions.map((s) => ({
    id: String(s._id),
    streamerName: streamerName(s.streamerChannelId),
    title: s.title ?? '',
    status: s.status as SessionStatus,
    processingStatus: s.processingStatus as ProcessingStatus,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    clipCount: s.clipCount ?? 0,
  }));

  return {
    counts: {
      streamers,
      liveStreamers,
      sessionsWaiting,
      sessionsProcessing,
      shortsGeneratedToday,
      shortsPublishedToday,
      failedJobs,
      awaitingReview,
      queuedUploads,
    },
    costs: { spentUsd, budgetUsd: values.values.costs.monthlyBudgetUsd },
    topShorts: (top as unknown as PopulatedClip[]).map(toClipSummary),
    recentSessions,
    latestClips: (clips as unknown as PopulatedClip[]).map(toClipSummary),
    recentUploads: (uploads as unknown as PopulatedClip[]).map(toClipSummary),
  };
}
