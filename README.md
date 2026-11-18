# AI Shorts Platform

Automated AI YouTube Shorts generator: monitor many streamer channels, detect when a live stream ends, find the strongest moments with AI, render vertical Shorts with subtitles, and publish everything to **one central YouTube channel**.

> Specification: `automated-ai-youtube-shorts-generator-spec.md` (kept outside the repo). Roadmap and feature ideas: [docs/ROADMAP.md](docs/ROADMAP.md).

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Monorepo, MongoDB/Redis, admin auth, dashboard shell, logging, validation, Docker | **Done** |
| 2 | Streamer CRUD, channel resolution, live detection, session lifecycle | **Done** |
| 3 | `VideoSourceProvider`, local-file provider, FFprobe validation | Next |
| 4 | Transcription + LLM highlight analysis | Planned |
| 5 | FFmpeg 9:16 rendering, subtitles, audio normalisation | Planned |
| 6 | Metadata + central YouTube OAuth upload | Planned |
| 7 | Auto-publish, scheduling, cost controls, hardening | Planned |

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
  - `integrations`: the YouTube metadata providers (real Data API and a mock for development), channel-URL parsing and quota tracking.
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
| GET / POST | `/api/v1/dev/mock-youtube/…` | ADMIN, only while the mock provider is active |

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

- **Providers.** With `YOUTUBE_API_KEY` set, the real YouTube Data API is used. Without it, a **mock provider** is used: any @handle resolves to a fake channel, and the ⋮ menu on the Streamers page can simulate a stream going live, ending cleanly, or dropping out.
- **Cheap detection.** Each channel's free uploads RSS feed lists its recent videos. One `videos.list` call (1 quota unit per 50 videos) then checks which of them are live, across all channels due in that tick. `YOUTUBE_LIVE_DETECTION=search` switches to `search.list` instead, at 100 units per check. Quota use is tracked per Pacific-time day and shown on the dashboard.
- **Reliable end detection.** A stream counts as ended when YouTube reports its end time, or after `endConfirmationChecks` consecutive "not live" checks. A failed API call never counts toward ending a stream.
- **Exactly once.** Each broadcast gets one session (unique index), and each ended session queues one media-acquisition job (unique key in `ProcessingJob`). Overlapping monitor runs claim channels with a lease, so no channel is checked twice at once.
- **No backfill.** Old streams that started before a channel was added are ignored. A stream that starts and ends between two checks is still picked up and processed.

## Environment

See [.env.example](.env.example). Phases 1–2 need MongoDB, Redis, `JWT_SECRET`, `ENCRYPTION_KEY` and the bootstrap admin. `YOUTUBE_API_KEY` is optional; without it the mock provider is used. `API_PORT` takes precedence over a generic `PORT`, because dev tooling and PaaS hosts often inject `PORT` into every child process.
