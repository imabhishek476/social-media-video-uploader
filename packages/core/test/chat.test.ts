import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@shorts/config';
import { ChatActivityModel, LiveSessionModel, StreamerChannelModel, connectDatabase, disconnectDatabase, mongoose, syncIndexes } from '@shorts/database';
import { chatScore, chatStats, createMemoryQuotaTracker, type LiveChatPage, type LiveChatProvider } from '@shorts/integrations';
import { SessionStatus } from '@shorts/shared-types';
import { ChatSampler, SettingsService, blendSignals, loadChatCounts } from '../src';

const MONGO_URI = process.env.TEST_MONGODB_URI_CHAT ?? 'mongodb://localhost:27017/ai_shorts_core_chat_test';

class FakeChat implements LiveChatProvider {
  pages: LiveChatPage[] = [];
  chatId: string | null = 'chat-1';
  tokens: Array<string | null> = [];
  async getActiveLiveChatId() {
    return this.chatId;
  }
  async listChatMessages(_id: string, token: string | null) {
    this.tokens.push(token);
    return this.pages.shift() ?? { messageTimes: [], nextPageToken: token, pollingIntervalMs: 5000, ended: false };
  }
}

const t0 = new Date('2026-11-01T18:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);

beforeAll(async () => {
  await connectDatabase(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await syncIndexes();
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

let chat: FakeChat;
let sampler: ChatSampler;
let sessionId: string;
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  chat = new FakeChat();
  sampler = new ChatSampler({ chat, quota: createMemoryQuotaTracker(), settings: new SettingsService(parseConfig({ NODE_ENV: 'test' })), dailyQuota: 10_000 });
  const ch = await StreamerChannelModel.create({ channelId: 'UC0000000000000000000001', channelUrl: 'https://x', displayName: 'S' });
  const s = await LiveSessionModel.create({ streamerChannelId: ch._id, broadcastId: 'vid00000001', status: SessionStatus.LIVE, startedAt: t0 });
  sessionId = String(s._id);
});

describe('ChatSampler', () => {
  it('buckets message times from the broadcast start and follows page tokens', async () => {
    chat.pages.push({ messageTimes: [at(1), at(5), at(12), at(-30)], nextPageToken: 'p2', pollingIntervalMs: 5000, ended: false });
    expect(await sampler.tick(at(20))).toMatchObject({ polled: 1, messages: 3 });
    // Not due yet (60 s default interval).
    expect(await sampler.tick(at(40))).toMatchObject({ polled: 0 });
    chat.pages.push({ messageTimes: [at(65), at(66)], nextPageToken: 'p3', pollingIntervalMs: 5000, ended: true });
    await sampler.tick(at(81));
    expect(chat.tokens).toEqual([null, 'p2']);
    const act = await ChatActivityModel.findOne({ liveSessionId: sessionId }).lean();
    expect(act).toMatchObject({ counts: [2, 1, 0, 0, 0, 0, 2], messageCount: 5, status: 'ENDED', pageToken: 'p3' });
    expect(await loadChatCounts(sessionId)).toEqual([]); // too few messages to trust
    expect(await loadChatCounts(sessionId, 5)).toEqual([2, 1, 0, 0, 0, 0, 2]);
  });

  it('marks streams without chat and skips sampling when turned off', async () => {
    chat.chatId = null;
    await sampler.tick(at(10));
    expect((await ChatActivityModel.findOne({ liveSessionId: sessionId }).lean())?.status).toBe('UNAVAILABLE');

    const settings = new SettingsService(parseConfig({ NODE_ENV: 'test' }));
    await settings.update({ monitoring: { chatPollSeconds: 0 } }, String(new mongoose.Types.ObjectId()));
    const off = new ChatSampler({ chat, quota: createMemoryQuotaTracker(), settings, dailyQuota: 10_000 });
    expect(await off.tick(at(100))).toMatchObject({ skipped: 'off' });
  });
});

describe('chat scoring', () => {
  it('scores ranges by the chat burst during and just after them', () => {
    const counts = Array.from({ length: 60 }, () => 4);
    counts[31] = 40; // burst at 310-320 s, right after a moment at 290-305 s
    const stats = chatStats(counts);
    expect(chatScore(counts, 290, 305, stats)).toBe(100);
    expect(chatScore(counts, 100, 130, stats)).toBe(0);
    expect(blendSignals(60, { audio: 50, audioWeight: 0.15, chat: 100, chatWeight: 0.2 })).toBe(Math.round(60 * 0.65 + 7.5 + 20));
    expect(blendSignals(60, { audio: 50, audioWeight: 0.15, chat: null, chatWeight: 0.2 })).toBe(Math.round(60 * 0.85 + 7.5));
  });
});
