# AI Shorts Platform

Automated AI YouTube Shorts generator: monitor many streamer channels, detect when a live stream ends, find the strongest moments with AI, render vertical Shorts with subtitles, and publish everything to **one central YouTube channel**.

> Specification: `automated-ai-youtube-shorts-generator-spec.md` (kept outside the repo). Roadmap and feature ideas: [docs/ROADMAP.md](docs/ROADMAP.md).

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Monorepo, MongoDB/Redis, admin auth, dashboard shell, logging, validation, Docker | **Done** |
| 2 | Streamer CRUD, channel resolution, live detection, session lifecycle | **Done** |
| 3 | `VideoSourceProvider`, local-file provider, FFprobe validation, Google Cloud Storage | **Done** |
| 4 | Transcription, loudness analysis, Claude highlight selection, Clip Studio review | **Done** |
| 5 | FFmpeg 9:16 rendering, word-by-word captions, loudness normalisation, thumbnails | **Done** |
| 6 | AI titles/descriptions/tags, approval, central-channel OAuth, resumable YouTube upload | **Done** |
| 7 | Publish windows, monthly AI budget, retention of finished streams, stuck-job watchdog, YouTube stats, Telegram alerts | **Done** |

## Architecture

```
apps/web  (React + MUI)  ──/api──▶  apps/api (Express 5)  ──▶ MongoDB
                                        │                      ▲
                                        ▼                      │
                                   Redis / BullMQ ◀──────▶ workers/engine (role-based worker)
```

- **apps/api**: REST API (`/api/v1`). Handlers are thin, and business logic lives in `src/services`.
- **workers/engine**: one deployable worker that runs the roles listed in `WORKER_ROLES` (`monitor`, `session`, `cleanup` so far), so heavy roles can later run in their own containers. Every job is mirrored to the `ProcessingJob` collection for the Job Monitor. Workers publish heartbeats to Redis, so the dashboard shows their status without opening ports.
- **packages/**
  - `config`: zod-validated environment and AES-256-GCM secret encryption.
  - `core`: domain services shared by the API and the worker: channel registration, live monitoring, session lifecycle and settings.
  - `integrations`: the YouTube Data API provider, channel-URL parsing and quota tracking. Test doubles live in `packages/integrations/testing` (`@shorts/integrations/testing`) and are never loaded by the app.
  - `shared-types`: enums, state machines, DTOs and request schemas, shared by the API and the web app.
  - `database`: Mongoose models and indexes for every spec entity.
  - `queue`: BullMQ queue registry, idempotency keys and heartbeats.
  - `observability`: pino logger with secret redaction.

## Quick start

Prerequisites: Node 20+, Docker.

```bash
npm install
cp .env.example .env        # then set JWT_SECRET, ENCRYPTION_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
npm run infra:up            # MongoDB + Redis in Docker
npm run dev                 # API :8080, worker, dashboard :5173
```

Open http://localhost:5173 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The admin is created on first API start, or run `npm run seed:admin`. Existing users are never modified. Remove `ADMIN_PASSWORD` from `.env` after the first login.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + worker + dashboard with hot reload |
| `npm run dev:api` / `dev:worker` / `dev:web` | One process at a time |
| `npm run infra:up` / `infra:down` | Start and stop MongoDB and Redis |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm test` | Vitest (API integration tests need `infra:up`) |
| `npm run build` | tsup bundles for API and worker, Vite build for the web app |
| `npm run seed:admin` | Create the bootstrap admin |
| `docker compose --profile app up --build` | Full stack in containers (dashboard on :8081) |

## API

| Method | Route | Auth |
|---|---|---|
| GET | `/api/v1/health` | public |
| GET | `/api/v1/ready` | public (MongoDB + Redis checks) |
| POST | `/api/v1/auth/login` | public, rate-limited |
| POST | `/api/v1/auth/logout` | session |
| GET | `/api/v1/auth/me` | session |
| GET | `/api/v1/dashboard/summary` | session |
| GET | `/api/v1/system/status` | session (readiness, workers, queue counts) |
| GET | `/api/v1/jobs`, `/api/v1/jobs/:id` | session |
| GET / PATCH | `/api/v1/settings` | session / ADMIN |
| GET / POST | `/api/v1/streamers` | session / ADMIN |
| GET / PATCH / DELETE | `/api/v1/streamers/:id` | session / ADMIN (delete is a soft delete) |
| PATCH | `/api/v1/streamers/:id/monitoring` | ADMIN (`{ "enabled": bool }`) |
| POST | `/api/v1/streamers/:id/check` | ADMIN (check on the next monitor tick) |
| GET | `/api/v1/live-sessions`, `/api/v1/live-sessions/:id` | session |
| POST | `/api/v1/live-sessions/:id/reprocess` | ADMIN |
| POST | `/api/v1/live-sessions/:id/source` | ADMIN (raw video body, `X-Upload-Filename` header) |
| GET | `/api/v1/live-sessions/:id/highlights` | session |
| GET | `/api/v1/live-sessions/:id/transcript?from&to` | session |
| GET | `/api/v1/live-sessions/:id/source/preview` | session (signed URL, 2 h) |
| PATCH | `/api/v1/highlights/:id` | ADMIN (`status`, `startSeconds`, `endSeconds`) |
| GET | `/api/v1/live-sessions/:id/clips` | session (latest render of each highlight) |
| POST | `/api/v1/live-sessions/:id/render` | ADMIN (`{ "force": true }` re-renders up-to-date clips) |
| GET | `/api/v1/clips/:id/media` | session (signed video + thumbnail URLs, 2 h) |
| PATCH | `/api/v1/clips/:id` | ADMIN (`title`, `description`, `tags`) |
| POST | `/api/v1/clips/:id/metadata` | ADMIN (rewrite metadata with the LLM) |
| POST | `/api/v1/clips/:id/approve`, `/reject` | ADMIN (approve queues the upload; also retries a failed one) |
| GET | `/api/v1/integrations/youtube/connect` | ADMIN (returns the Google consent URL) |
| GET | `/api/v1/integrations/youtube/callback` | public, protected by single-use `state` |
| DELETE | `/api/v1/integrations/youtube` | ADMIN (revoke and disconnect) |

Errors always use the shape `{ "error": { "code", "message", "details?", "requestId" } }`.

## Security notes

- Sessions use a JWT in an `httpOnly`, `SameSite=Strict` cookie (`Secure` in production). The user is reloaded on every request, so disabling a user takes effect immediately.
- Mutating requests that carry a body must be JSON, which is a CSRF defence on top of SameSite. Helmet, CORS and rate limits are on.
- Passwords are hashed with bcrypt (cost 12). Login timing is equalised, so it doesn't reveal which emails exist.
- OAuth refresh tokens will be stored encrypted (`IntegrationCredential.encryptedRefreshToken`, AES-256-GCM via `ENCRYPTION_KEY`).
- Logs redact authorization headers, cookies, passwords, tokens and API keys.
- Production refuses to start without `JWT_SECRET` and `ENCRYPTION_KEY`.

## Layout

```
apps/api            Express API (src/routes, src/services, src/middleware, test/)
apps/web            React dashboard (src/pages, src/api hooks, src/components)
workers/engine      BullMQ worker process (src/processors, tracked-job wrapper)
packages/*          config, shared-types, database, queue, observability
infra/docker        Multi-target Dockerfile (api / worker+ffmpeg / web+nginx)
docs/               Roadmap and feature proposals
```

## Live detection (Phase 2)

- **Provider.** Live detection uses the YouTube Data API (`YOUTUBE_API_KEY`, required).
- **Cheap detection.** Each channel's free uploads RSS feed lists its recent videos. One `videos.list` call (1 quota unit per 50 videos) then checks which of them are live, across all channels due in that tick. `YOUTUBE_LIVE_DETECTION=search` switches to `search.list` instead, at 100 units per check. Quota use is tracked per Pacific-time day and shown on the dashboard.
- **Reliable end detection.** A stream counts as ended when YouTube reports its end time, or after `endConfirmationChecks` consecutive "not live" checks. A failed API call never counts toward ending a stream.
- **Exactly once.** Each broadcast gets one session (unique index), and each ended session queues one media-acquisition job (unique key in `ProcessingJob`). Overlapping monitor runs claim channels with a lease, so no channel is checked twice at once.
- **No backfill.** Old streams that started before a channel was added are ignored. A stream that starts and ends between two checks is still picked up and processed.

## Source media and storage (Phase 3)

- **Getting a recording.** The YouTube API never provides another channel's video file, so recordings come from a permitted source:
  - **Storage inbox (automatic):** upload the recording to `incoming/<videoId>.mp4` (or `.mkv`, `.webm`, `.mov`) in the bucket. Streamers can do this, OBS plus rclone or gsutil can, or you can in the Cloud Console. Every 2 minutes the worker matches new files to their session and starts processing. A file named after a video ID that has no session yet is imported as a missed live, if the channel is a registered streamer. The inbox object is deleted once the recording is stored.
  - **Upload button** on the session panel.
- **Missed lives.** Live Sessions → **Add missed live** takes any YouTube link (`watch?v=`, `youtu.be/`, `/live/`, `/shorts/`) from a registered streamer. An ended stream is queued right away, and one that is still live is tracked until it ends. API: `POST /api/v1/live-sessions/import { "url": "…" }`.
- **Validation.** FFprobe checks every file for a video and an audio stream, a duration over 10 seconds, and the duration and size limits from Settings → Processing. Rejected files are deleted and the reason is shown on the session.
- **Storage.** `STORAGE_PROVIDER=gcs` stores recordings in your Google Cloud Storage bucket (`GCS_BUCKET`, `GCS_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` pointing at the key file). `local` keeps them in `storage/objects/`. Keys are `raw/<sessionId>/source.<ext>`. Uploads are resumable and checksum-verified.
- **Retention.** Raw recordings are deleted after `retention.sourceDays` (Settings, default 7, 0 keeps them). An hourly job does it and marks the session as expired. Add a GCS lifecycle rule for `raw/` as a backstop.
- **Docker.** The API and worker must share `STORAGE_DIR` (the compose file mounts one volume) so dashboard uploads reach the worker.

## Transcription and highlights (Phase 4)

- **Flow.** Once a recording is stored, the `transcription` job downloads it, extracts speech audio (mono 16 kHz MP3, split into pieces under the provider's 25 MB limit), measures loudness for every second, and transcribes each piece. Then the `highlight` job analyses the stream in 30-minute windows, validates the proposed timestamps, merges duplicates, and saves the candidates. The session ends in **Highlights ready**.
- **Providers** (`.env`):
  - `TRANSCRIPTION_PROVIDER=openai` uses any Whisper-compatible API: OpenAI `whisper-1` (about $0.006/min), or Groq by changing `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL`.
  - `LLM_PROVIDER=gemini` uses Google Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL`, default `gemini-3.8-flash`) with a response schema. It works on Gemini's free tier.
  - Free transcription: Groq's Whisper (`TRANSCRIPTION_BASE_URL=https://api.groq.com/openai/v1`, `TRANSCRIPTION_MODEL=whisper-large-v3-turbo`). The free tier covers about 8 hours of audio per day.
  - `LLM_PROVIDER=anthropic` uses Claude (`LLM_MODEL`, default `claude-opus-5-5`) with structured outputs. `LLM_API_KEY` is optional; the SDK also reads `ANTHROPIC_API_KEY`.
  - Server-side refusal fallback is on: if the model declines a transcript, the API retries it on a fallback model.
- **Scoring.** Claude scores hook, emotion, entertainment, context, payoff and clarity. The final score adds 15% from the loudness signal. The top `maxClipsPerStream` candidates at or above `minHighlightScore` are auto-selected. Lower-scoring ones are kept as candidates or discarded with a reason.
- **Validation.** Clips are clamped to the recording, forced into the min/max length around the key moment, snapped to sentence boundaries, and overlapping clips are merged or de-duplicated.
- **Clip Studio** (`/clips`) previews the recording (a signed GCS URL), shows a 9:16 frame overlay, lists candidates with their score breakdown, and lets admins select, discard and trim clips. Clips a person selected or trimmed survive re-analysis.
- **Reprocess** reuses the existing transcript (the expensive step) and re-runs only the analysis. Each session shows an estimated AI cost.

## Rendering Shorts (Phase 5)

- **When.** After analysis, the `render` job turns every **Selected** highlight into a Short. In Clip Studio, **Render selected** renders new or trimmed picks, and **Re-render all** applies changed caption or reframing settings.
- **Output.** 1080×1920 H.264 at 30 fps, AAC 48 kHz, fast-start MP4, plus a JPEG thumbnail at the key moment. Files are stored at `clips/<sessionId>/<clipId>/v<version>.{mp4,jpg,ass}`.
- **Reframing** (Settings → Clips):
  - `CENTER_CROP` crops the middle of the frame.
  - `BLUR_FIT` keeps the whole 16:9 frame over a blurred background.
  - `FACECAM_SPLIT` is the streamer layout: the webcam fills the top 768 px and gameplay fills the rest. The facecam is found once per stream: 3 frames go to the LLM's vision (Gemini, or Claude), and the box is stored on the session. If there's no webcam, for example IRL or just chatting, that stream uses `BLUR_FIT`. In Clip Studio you can **Draw facecam box** on the source video or **Detect again**, then **Re-render all**.
- **Captions.** Burned-in, 2–3 words at a time, uppercase, with the spoken word in the highlight colour. Font, size, colours and position come from Settings → Subtitles. Word timing is exact: Whisper returns timestamps for every word. Transcripts made before this change use estimated timing; press **Re-transcribe** on the session to upgrade one.
- **Audio.** Two-pass EBU R128 normalisation to −14 LUFS, the level YouTube and mobile playback expect.
- **Versions.** Trimming a highlight creates a new render version. Older versions that were never uploaded are deleted with their files. Each clip is claimed through a unique index, so parallel workers never render the same clip twice, and a render claim left by a crashed worker is taken over after 30 minutes.
- **Fonts.** The worker Docker image installs Montserrat and Noto. Locally, libass falls back to a system font if the configured one is missing.

## Publishing (Phase 6)

- **Metadata.** After rendering, the `metadata` job writes a title (at most 90 characters), a description with a credit link to the original stream plus hashtags (always `#Shorts`), and search tags. It uses the configured LLM (Gemini, Claude, or a template offline). The output is cleaned to YouTube's limits: no `<` or `>`, and tags within 500 characters. Admins can edit the text or press **Rewrite with AI** in Clip Studio.
- **Approval.** In `MANUAL_APPROVAL` mode (the default), nothing uploads until an admin presses **Approve & upload**. In `AUTO_PUBLISH` mode, clips are approved as soon as their metadata exists.
- **Upload.** The `upload` job runs one upload at a time. It uses the YouTube resumable protocol in 8 MiB chunks with the default privacy from Settings → Publishing. The session URL is saved, so a crash resumes the same upload; an upload that had already finished is recovered rather than repeated. Each clip has a stable idempotency key and the video ID is unique in the database.
- **Pacing.** `dailyUploadLimit` (0 means no limit) and `minMinutesBetweenUploads` delay jobs instead of failing them. When the YouTube quota runs out, uploads wait until the quota resets at midnight Pacific time.
- **Connection.** Settings has **Connect YouTube channel**, which runs an OAuth web-server flow with `youtube.upload` and `youtube.readonly` scopes. The refresh token is stored encrypted with `ENCRYPTION_KEY`, and the callback is protected by a single-use `state`. A revoked token marks the connection as **Needs reconnect**.

## Speech-to-text on your machine

Set `TRANSCRIPTION_PROVIDER=local` to transcribe English with NVIDIA Parakeet (sherpa-onnx). It's free, has no rate limits, and the audio never leaves the machine. On 4–6 CPU threads, a 6-hour stream takes about 45–60 minutes.
- **Model files:** download once into `storage/models/parakeet-tdt-0.6b-v2-int8` (see `.env.example`).
- **Other languages:** streamers whose language is set to anything other than English (streamer **Edit → Language**, e.g. `hi`) use the `TRANSCRIPTION_*` API (Groq Whisper) instead.
- **Separate process:** speech-to-text runs in its own process, so the worker never freezes.
- **Restarts:** jobs use short, auto-renewed locks, so a job interrupted by a restart resumes within about 2 minutes.

## Scheduled publishing (Phase 8)

Shorts can go public at good times instead of the moment they upload.

- **Settings → Publishing → When Shorts go public**
  - `BEST_TIME` (default): the hours when this channel's Shorts got the most views (last 60 days; needs about 30 Shorts with views, at least 3 per hour). Until then the **Slot times** are used.
  - `FIXED_SLOTS`: exactly the **Slot times**, e.g. `12:30, 15:30, 18:00, 21:00`, in the **Time zone**.
  - `IMMEDIATE`: public as soon as uploaded (the old behaviour, with the publish window, daily limit and gap).
- **Gap between posting days** (0 = daily, 1 = every other day…), **Days without posts** (e.g. `Sun`) and **Max per stream per day** (spreads one stream's Shorts over several days).
- Scheduling needs **Default privacy = public**. With private or unlisted, Shorts upload as before.

How it works:
1. On approval, the Short gets the next free slot (one Short per slot, at least 20 minutes away).
2. It uploads right away as **private with `publishAt`**, and YouTube makes it public at the slot, so a slow upload or quota pause never makes a slot late.
3. With Instagram `WITH_YOUTUBE`, the Reel waits for the same slot.
4. The **Schedule** page lists the next 14 days. **Move** changes the time (also on YouTube; ~50 quota units), **Publish now** makes it public immediately.

## Better Shorts: hook, caption styles, gameplay layout, games

- **Hook text:** the AI writes a 2–6 word hook ("HE GOT ME", "1 VS 3") for each moment. It's drawn in a white box at the top: *Settings → Subtitles → Hook text on video* (`ALWAYS`, `INTRO` = first 4 s, `OFF`).
- **Caption styles** (*Settings → Subtitles → Caption style*):
  - `HYPE`: Anton, 2 words, red;
  - `BOUNCE`: Poppins ExtraBold, 3 words, cyan;
  - `CLEAN`: 4 words, normal case;
  - `CUSTOM`: the font, size and colours you set.

  The spoken word "pops". The fonts are bundled in `packages/core/fonts` (SIL Open Font License).
- **Gameplay layout** (*Settings → Clips → Reframing mode → GAMEPLAY*): the game fills the Short and the webcam sits in the top-left with a neon border. Clip Studio's facecam tools work for it. Without a webcam, it falls back to a centre crop.
- **Games:** about 20 games are recognised from the streamer's *Main game* setting or the stream title. When the game is known:
  - the AI judges moments the way that game's players would;
  - every post gets the game's hashtags (e.g. `#GTA6 #GTAVI #ViceCity`).
- **Ads and static screens:** stretches where the picture doesn't change for 20 s or more (ad slates, BRB screens, frozen video) are found with ffmpeg in about a minute per 6-hour stream, and clips there are dropped.
- **Chat:** chat spikes count *different people*, so a single spammer or bot wave doesn't count as a crowd reacting.
- **"Clip it":** lines where someone says "clip it" or "clip that" are flagged to the AI.

## Live chat signal

While a stream is live, the worker reads its YouTube live chat every `chatPollSeconds` (Settings → Monitoring, default 60, 0 = off). Only the number of messages per 10 seconds is stored, not their text or authors. Analysis uses the stored counts in two ways:

- **In the prompt.** Transcript lines followed by a chat burst are tagged `(CHAT SPIKE xN)` for the AI.
- **In the score.** A chat score (0–100) is blended into each highlight's score at a 20 % weight and shown as `chat` in the score breakdown. The window runs from the clip's start to 20 s past its end, because chat reacts late.

Each chat read costs about 5 quota units, so 60 s is about 300 units per live hour. Sampling stops at 80 % of the daily quota, which leaves room for live detection and uploads. Streams with chat turned off, recordings added later, and streams with fewer than 50 captured messages are scored without chat.

## Instagram Reels

Rendered Shorts can also be posted as Reels to an Instagram **Business or Creator** account. Posting uses the Instagram API with Instagram Login and a resumable upload, so no public video URL is needed.

1. In [Meta for Developers](https://developers.facebook.com/), create an app (type **Business**) and add the **Instagram** product, under "API setup with Instagram login".
2. Add your Instagram account as a tester and accept the invite in the Instagram app.
3. Generate an access token for the account with `instagram_business_basic` and `instagram_business_content_publish`. The dashboard's token generator gives a 60-day long-lived token.
4. In the app, open Settings → **Instagram Reels**, paste the token and press **Connect Instagram**. The token is checked, then stored encrypted with `ENCRYPTION_KEY`. A daily job renews it before it expires.

Once connected:
- Clip Studio has **Post to Instagram** for each rendered Short.
- Settings → Publishing → Instagram Reels = `WITH_YOUTUBE` also queues the Reel whenever a Short is approved.
- Reels respect the publish window.
- Hitting Instagram's 24-hour publishing limit delays the Reel instead of failing it.
- The caption is the title and description, plus the tags as hashtags (at most 30 hashtags and 2,200 characters).

## Automation and hardening (Phase 7)

- **Publish window.** Settings → Publishing → window start and end hour plus a time zone, for example 17–23 `Asia/Kolkata`. Approved Shorts only start uploading inside the window, after the daily limit and minimum gap are also satisfied. 0–24 means any time.
- **Monthly AI budget.** Settings → Costs. When this month's estimated transcription and LLM spend reaches the budget, transcription, analysis and metadata jobs pause. They re-check every 6 hours, so raising the budget resumes them. The dashboard shows month-to-date spend. 0 means no cap.
- **Retention.**
  - Each stream's raw recording is deleted `sourceAfterDoneDays` (default 3) after all of its Shorts are published or rejected. The `sourceDays` cap still applies as a backstop.
  - Rendered files of Shorts that were published or rejected more than `clipDays` ago are deleted. The record and YouTube link are kept.
  - Transcripts older than `transcriptDays` are deleted.
  - All of this runs in the hourly cleanup job.
- **Watchdog.** Every 15 minutes, sessions stuck in "running" with no live job for 3 hours are marked failed with a Reprocess hint.
- **YouTube stats.** Every 6 hours, views, likes and comments are fetched for Shorts published in the last 90 days. That costs 1 quota unit per 50 videos. The dashboard lists the top Shorts, and Shorts deleted on YouTube are flagged.
- **Alerts.** Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to get messages when Shorts are ready for review, published, or failed, when processing fails or stalls, when YouTube needs reconnecting, and when the budget is reached. Without them, alerts go to the worker log.

## Environment

See [.env.example](.env.example). Phases 1–2 need MongoDB, Redis, `JWT_SECRET`, `ENCRYPTION_KEY` and the bootstrap admin. Outside tests the app refuses to start without real provider keys: `YOUTUBE_API_KEY`, `YOUTUBE_CLIENT_ID`/`SECRET`, `ENCRYPTION_KEY`, `TRANSCRIPTION_API_KEY`, and `GEMINI_API_KEY` (or the Claude key with `LLM_PROVIDER=anthropic`). `API_PORT` takes precedence over a generic `PORT`, because dev tooling and PaaS hosts often inject `PORT` into every child process.
