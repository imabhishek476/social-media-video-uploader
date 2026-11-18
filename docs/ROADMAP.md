# Roadmap, blockers and feature proposals

## 1. Blockers to resolve early

These decide whether the product can work at all. Resolve them before Phase 3 and Phase 6, not after.

### 1.1 Source-media acquisition (spec §1, §6-D)
The YouTube Data API does not provide a way to download another channel's video file. The pipeline is built around a pluggable `VideoSourceProvider`, but a real, permitted source has to be chosen. Realistic options:

| Option | How it works | Notes |
|---|---|---|
| **Creator-supplied VODs** (recommended) | Streamers who opt in share recordings: an upload link, a Google Drive or Dropbox folder, or an S3 bucket the system watches | Clean on rights and terms of service. Pairs with the rights registry in §3.1 |
| **OBS / recording push** | Streamer's OBS records locally, and rclone or a small agent pushes the file to our storage after the stream | Best quality, no platform dependency |
| **Manual upload** | Admin uploads the VOD in the dashboard | Always available as a fallback. Easy to build in Phase 3 |
| Third-party downloader | Scrape the public VOD | Breaks YouTube's terms of service. **Not recommended** |

**Decision needed:** which provider(s) to build after the local-file provider.

### 1.2 YouTube upload quota and audit (spec §15). Verify the current numbers before relying on them
- The default Data API quota is about **10,000 units a day**. `videos.insert` has historically cost about **1,600 units**, which means only about 6 uploads a day on the default quota. Apply for a quota extension early.
- `search.list` costs about **100 units** per call, so polling every channel with `search?eventType=live` burns quota quickly. See §2 for a cheaper way to detect streams.
- Uploads from **unverified API projects are locked to private** until the project passes YouTube's API compliance audit. The OAuth consent screen with the `youtube.upload` scope also needs Google verification before production use.

### 1.3 Content rights
Republishing other creators' streams needs their permission (copyright, Content ID, channel strikes). Track consent per streamer (see §3.1).

## 2. Phase 2 (done) and Phase 3 plan (next)

Phase 2 shipped everything in the earlier plan: streamer CRUD, channel resolution from any URL format, quota-efficient live detection (RSS feed plus batched `videos.list`), a session watcher that confirms stream ends, exactly-once processing hand-off, and a mock provider with dev controls. See the README section "Live detection".

Not done yet in Phase 2:
- **WebSub push notifications.** These would detect a stream start within seconds instead of at the polling interval. They need a public callback URL, so they belong with deployment work.
- **Upcoming (scheduled) broadcasts** are not tracked. Only streams that are live or already ended create sessions.

Phase 3 plan:
1. A `VideoSourceProvider` interface: `acquire(session) → { kind: 'file' | 'url', … }`.
2. A **local-file provider** (drop a recording into `storage/incoming/<broadcastId>.*`) and a **manual upload** endpoint and UI.
3. A worker role for the `media-acquisition` queue that copies the file to storage, validates it with FFprobe (duration, codecs, audio), and moves the session to `SOURCE_PENDING`, then `SOURCE_READY` or `SOURCE_UNAVAILABLE`.
4. Retries with backoff, plus a clear `SOURCE_UNAVAILABLE` state with a Reprocess action.
5. Size and duration limits taken from Settings → Processing.

## 3. Proposed features beyond the spec

Priority runs ★★★ (high impact, cheap relative to value) down to ★.

### Content quality
- ★★★ **Live-chat velocity signal.** While a stream is live, sample `liveChatMessages` (the chat ID comes from `videos.list`) and store message rate per minute. Spikes in chat are one of the strongest highlight signals and cheap to collect. Clipping still happens after the stream ends (the spec's post-live rule holds); only the signal is recorded during the live.
- ★★★ **Facecam + gameplay split layout.** Detect the webcam overlay region once per stream and render a stacked 9:16 layout: facecam on top, gameplay below. This is the usual Shorts format for streamers and far better than a centre crop.
- ★★★ **Hook-first editing.** Optionally open with a 1–2 s teaser of the payoff, trim silences into jump cuts, and add punch-in zooms on reactions.
- ★★ **Word-level "karaoke" captions** with emphasis colours and optional emoji, styled per channel.
- ★★ **Cross-stream de-duplication** with transcript embeddings and perceptual hashes, so the same joke or meme isn't published twice in a week.
- ★★ **Multi-language.** Translated subtitles plus YouTube `localizations` for titles and descriptions to reach more viewers.

### Publishing and growth
- ★★★ **Analytics feedback loop.** Pull YouTube Analytics (views, average view percentage, likes, subscribers gained) for every published Short and learn per-streamer and per-category score weights. The "viral score" then improves based on real results.
- ★★ **Smart scheduler.** Spread uploads across the day based on audience-activity data, avoid posting the same streamer back to back, and respect the daily limit and quota.
- ★★ **Title and hook variants.** Generate 3 candidates per clip, pick one in review, and record which style performs best.
- ★★ **Automatic attribution.** Add a description template with the streamer's channel, a link to the original VOD and a timestamp. Optionally pin a comment pointing to the full stream.

### Safety and compliance
- ★★★ **Rights and consent registry.** Store per-streamer consent status, allowed content types, revenue-share notes and attribution rules. Block publishing for streamers without consent.
- ★★ **Pre-publish checks.** Profanity and sensitive-topic classifiers, copyrighted-music detection (audio fingerprinting) to avoid Content ID claims, and the `containsSyntheticMedia` and made-for-kids flags.

### Operations
- ★★★ **Notifications.** Telegram, Slack or email alerts for "N clips ready for review", job failures, quota at 80 %, OAuth token revoked.
- ★★ **Mobile approval.** A Telegram bot or PWA push with a preview and Approve/Reject buttons, so review doesn't need a desktop.
- ★★ **Cost dashboard.** Cost per stream-hour by provider (STT, LLM, compute), with monthly budget caps that pause processing.
- ★ **More source platforms.** Twitch and Kick monitoring through the same provider interfaces. Twitch EventSub gives push `stream.online` / `stream.offline` events.
- ★ **Editor role and clip timeline.** Trim handles on a waveform, click a transcript line to jump to it, and re-render with adjusted boundaries.

## 4. Open product questions (spec §25)
Defaults currently configured: English, 5 clips per stream, 30–60 s clips, manual approval, private uploads, daily limit 10. All of these can be changed in Settings. Still to decide: source provider (§1.1), transcription and LLM vendors, monthly budget, retention periods.
