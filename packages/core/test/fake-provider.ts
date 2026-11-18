import { ProviderError, type ChannelRef, type ResolvedChannel, type VideoDetails, type YouTubeMetadataProvider } from '@shorts/integrations';

/** Scriptable in-memory provider for deterministic lifecycle tests. */
export class FakeProvider implements YouTubeMetadataProvider {
  readonly name = 'mock' as const;
  channels = new Map<string, ResolvedChannel>();
  videos = new Map<string, VideoDetails>();
  failDiscovery = new Set<string>();
  failGetVideos = 0;
  calls = { discovery: 0, getVideos: 0 };

  addChannel(n: number): ResolvedChannel {
    const c = { channelId: `UC${String(n).padStart(22, '0')}`, title: `Streamer ${n}`, handle: `@streamer${n}`, thumbnailUrl: null };
    this.channels.set(c.channelId, c);
    return c;
  }

  goLive(channelId: string, videoId: string, startedAt = new Date()): void {
    this.videos.set(videoId, {
      videoId,
      channelId,
      title: `Live ${videoId}`,
      liveBroadcastContent: 'live',
      actualStartTime: startedAt,
      actualEndTime: null,
      scheduledStartTime: null,
    });
  }

  end(videoId: string, mode: 'clean' | 'ambiguous' | 'vanish', at = new Date()): void {
    const v = this.videos.get(videoId)!;
    if (mode === 'vanish') this.videos.delete(videoId);
    else this.videos.set(videoId, { ...v, liveBroadcastContent: 'none', actualEndTime: mode === 'clean' ? at : null });
  }

  async resolveChannel(ref: ChannelRef): Promise<ResolvedChannel | null> {
    for (const c of this.channels.values()) {
      if ((ref.kind === 'id' && c.channelId === ref.value) || (ref.kind === 'handle' && c.handle === ref.value)) return c;
    }
    return null;
  }

  async listCandidateVideoIds(channelId: string): Promise<string[]> {
    this.calls.discovery++;
    if (this.failDiscovery.has(channelId)) throw new ProviderError('NETWORK', 'simulated outage', true);
    return [...this.videos.values()].filter((v) => v.channelId === channelId).map((v) => v.videoId);
  }

  async getVideos(ids: string[]): Promise<VideoDetails[]> {
    this.calls.getVideos++;
    if (this.failGetVideos > 0) {
      this.failGetVideos--;
      throw new ProviderError('NETWORK', 'simulated API failure', true);
    }
    return ids.map((id) => this.videos.get(id)).filter((v): v is VideoDetails => Boolean(v));
  }
}
