import crypto from 'node:crypto';
import { mongoose, type Model } from '@shorts/database';
import { isChannelId } from '../src/youtube/parse';

export interface MockChannelDTO {
  channelId: string;
  handle: string | null;
  title: string;
  live: { videoId: string; title: string; startedAt: string } | null;
}
import type { ChannelRef, ResolvedChannel, VideoDetails, YouTubeMetadataProvider } from '../src/youtube/types';

/**
 * Development provider (spec §21: "use test fixtures and mock providers so
 * the project can be developed without waiting for real streamers to go
 * live"). State lives in MongoDB so the API (which simulates go-live/end) and
 * the worker (which detects it) share it.
 */
const { Schema, model, models } = mongoose;

const mockChannelSchema = new Schema(
  {
    channelId: { type: String, required: true, unique: true },
    handle: { type: String, default: null },
    title: { type: String, required: true },
  },
  { timestamps: true, collection: 'dev_mock_youtube_channels' },
);

const mockVideoSchema = new Schema(
  {
    videoId: { type: String, required: true, unique: true },
    channelId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    liveBroadcastContent: { type: String, enum: ['live', 'upcoming', 'none'], default: 'none' },
    actualStartTime: { type: Date, default: null },
    actualEndTime: { type: Date, default: null },
    /** Simulates a broadcast that became private/deleted (absent from the API). */
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'dev_mock_youtube_videos' },
);

interface MockChannel {
  channelId: string;
  handle: string | null;
  title: string;
}
interface MockVideo {
  videoId: string;
  channelId: string;
  title: string;
  liveBroadcastContent: 'live' | 'upcoming' | 'none';
  actualStartTime: Date | null;
  actualEndTime: Date | null;
  hidden: boolean;
  createdAt: Date;
}

const MockChannelModel = (models.DevMockYouTubeChannel as Model<MockChannel>) ?? model<MockChannel>('DevMockYouTubeChannel', mockChannelSchema);
const MockVideoModel = (models.DevMockYouTubeVideo as Model<MockVideo>) ?? model<MockVideo>('DevMockYouTubeVideo', mockVideoSchema);

const FIXTURES: MockChannel[] = [
  { handle: '@mock-gamer', title: 'Mock Gamer', channelId: fakeChannelId('@mock-gamer') },
  { handle: '@mock-talkshow', title: 'Mock Talk Show', channelId: fakeChannelId('@mock-talkshow') },
  { handle: '@mock-irl', title: 'Mock IRL Streams', channelId: fakeChannelId('@mock-irl') },
];

function fakeChannelId(seed: string): string {
  return 'UC' + crypto.createHash('sha256').update(seed.toLowerCase()).digest('base64url').slice(0, 22);
}

const titleFromHandle = (handle: string) =>
  handle
    .replace(/^@/, '')
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');

export type MockEndMode = 'clean' | 'ambiguous' | 'vanish';

export class MockYouTubeProvider implements YouTubeMetadataProvider {
  readonly name = 'mock' as const;

  async ensureFixtures(): Promise<void> {
    await MockChannelModel.bulkWrite(
      FIXTURES.map((f) => ({ updateOne: { filter: { channelId: f.channelId }, update: { $setOnInsert: f }, upsert: true } })),
    );
  }

  async resolveChannel(ref: ChannelRef): Promise<ResolvedChannel | null> {
    await this.ensureFixtures();
    let channel: MockChannel | null = null;
    switch (ref.kind) {
      case 'id':
        channel = await MockChannelModel.findOne({ channelId: ref.value }).lean();
        if (!channel && isChannelId(ref.value)) channel = await this.create({ channelId: ref.value, handle: null, title: `Channel ${ref.value.slice(-6)}` });
        break;
      case 'handle':
      case 'username':
      case 'custom': {
        const handle = ref.value.startsWith('@') ? ref.value : `@${ref.value}`;
        channel =
          (await MockChannelModel.findOne({ handle: handle.toLowerCase() }).lean()) ??
          (await this.create({ channelId: fakeChannelId(handle), handle: handle.toLowerCase(), title: titleFromHandle(handle) }));
        break;
      }
      case 'video': {
        const video = await MockVideoModel.findOne({ videoId: ref.value }).lean();
        channel = video ? await MockChannelModel.findOne({ channelId: video.channelId }).lean() : null;
        break;
      }
    }
    if (!channel) return null;
    return {
      channelId: channel.channelId,
      title: channel.title,
      handle: channel.handle,
      thumbnailUrl: null,
    };
  }

  async listCandidateVideoIds(channelId: string): Promise<string[]> {
    const videos = await MockVideoModel.find({ channelId }).sort({ createdAt: -1 }).limit(15).lean();
    return videos.map((v) => v.videoId);
  }

  async getVideos(videoIds: string[]): Promise<VideoDetails[]> {
    const videos = await MockVideoModel.find({ videoId: { $in: videoIds }, hidden: false }).lean();
    return videos.map((v) => ({
      videoId: v.videoId,
      channelId: v.channelId,
      title: v.title,
      liveBroadcastContent: v.liveBroadcastContent,
      actualStartTime: v.actualStartTime,
      actualEndTime: v.actualEndTime,
      scheduledStartTime: null,
    }));
  }

  // --- Dev controls (not part of the provider interface) ----------------------

  async listChannels(): Promise<MockChannelDTO[]> {
    await this.ensureFixtures();
    const [channels, live] = await Promise.all([
      MockChannelModel.find().sort({ title: 1 }).lean(),
      MockVideoModel.find({ liveBroadcastContent: 'live', hidden: false }).lean(),
    ]);
    const liveByChannel = new Map(live.map((v) => [v.channelId, v]));
    return channels.map((c) => {
      const v = liveByChannel.get(c.channelId);
      return {
        channelId: c.channelId,
        handle: c.handle,
        title: c.title,
        live: v ? { videoId: v.videoId, title: v.title, startedAt: (v.actualStartTime ?? v.createdAt).toISOString() } : null,
      };
    });
  }

  /** Start a simulated broadcast (idempotent: returns the current one if already live). */
  async goLive(channelId: string, title?: string): Promise<{ videoId: string }> {
    const channel = await MockChannelModel.findOne({ channelId }).lean();
    if (!channel) throw new Error(`Unknown mock channel ${channelId}`);
    const existing = await MockVideoModel.findOne({ channelId, liveBroadcastContent: 'live', hidden: false }).lean();
    if (existing) return { videoId: existing.videoId };
    const videoId = crypto.randomBytes(8).toString('base64url').slice(0, 11);
    await MockVideoModel.create({
      videoId,
      channelId,
      title: title ?? `${channel.title} LIVE — ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
      liveBroadcastContent: 'live',
      actualStartTime: new Date(),
    });
    return { videoId };
  }

  /**
   * End the current simulated broadcast.
   *  - clean:     provider reports actualEndTime (authoritative end)
   *  - ambiguous: no longer live but no end time (needs N confirmations)
   *  - vanish:    broadcast disappears from the API (private/deleted)
   */
  async endLive(channelId: string, mode: MockEndMode = 'clean'): Promise<{ videoId: string } | null> {
    const video = await MockVideoModel.findOne({ channelId, liveBroadcastContent: 'live', hidden: false });
    if (!video) return null;
    video.liveBroadcastContent = 'none';
    if (mode === 'clean') video.actualEndTime = new Date();
    if (mode === 'vanish') video.hidden = true;
    await video.save();
    return { videoId: video.videoId };
  }

  private async create(c: MockChannel): Promise<MockChannel> {
    await MockChannelModel.updateOne({ channelId: c.channelId }, { $setOnInsert: c }, { upsert: true });
    return (await MockChannelModel.findOne({ channelId: c.channelId }).lean())!;
  }
}
