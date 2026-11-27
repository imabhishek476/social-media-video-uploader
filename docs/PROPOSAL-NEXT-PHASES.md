# Proposal: next phases (8–14)

The goal is a channel that grows **on its own**. Shorts are found, edited in a viral style, scheduled at the best time and published without clicks. Performance data keeps making them better.

This proposal turns the ideas in `Future-Features.log` into an ordered build plan. Each phase ships on its own, is useful by itself, and unlocks the next one.

| Phase | Name | Why this order | Size |
|---|---|---|---|
| 8 | Scheduled publishing at the best time | Fastest win; most of the plumbing exists | S (2–3 days) |
| **8.5** | **Growth & monetization** (cold-open cuts, loops, Shorts analytics, niche focus, comments, weekly compilation, originality layer) | Videos aren't getting views; fix reach before automating more. See `docs/GROWTH-STRATEGY.md` | M (5–7 days) |
| 9 | Autopilot (no clicks) | Removes daily manual work; needs Phase 8's schedule | S–M (3–4 days) |
| 10 | Categories and presets | Lets autopilot use the right style per content type | M (4–5 days) |
| 11 | Any YouTube video ("Video clipper") | New content source beyond streams; uses Phase 10 presets | M (5–6 days) |
| 12 | Viral-style dynamic editing | Biggest quality jump; applies to every source | L (8–10 days) |
| 13 | Clipping while the stream is live | Speed advantage; most complex, so it builds on stable parts | L (8–10 days) |
| 14 | Learning loop | Needs a few weeks of published data from Phases 8–13 | M (5 days) |

Sizes are working days for one developer, including tests.

---

## Before Phase 8: things to settle (owner: you)

1. **Publish the Google OAuth app to "In production"** (Google Cloud → OAuth consent screen). In Testing mode the YouTube token expires every 7 days, and autopilot would stop each week.
2. **YouTube upload quota.** The default quota is 10,000 units a day, and each upload costs about 1,600, so about **6 uploads a day**. For more, apply for a quota increase now; approval takes weeks.
3. **Rights for non-stream videos (Phase 11).** You have consent from the streamers. Random YouTube videos are different: reuploads can get Content ID claims or copyright strikes, and three strikes remove the channel. Phase 11 therefore records a **permission/licence note per video** and defaults to *review before publish* for these sources.

---

## Phase 8: Scheduled publishing at the best time

**Goal:** every Short goes out at a good time, on a calendar, without you choosing times.

**What exists already:**
- A publish window (start and end hour).
- A gap between uploads and a daily limit.
- `scheduledPublishAt` on clips.

**What changes:**
- **Upload early, go public later.**
  - Shorts upload as *Private* with YouTube's `publishAt`, and YouTube makes them Public at the slot time.
  - Uploading ahead means a quota or network problem never makes a slot late.
- **New setting "Publish timing":**
  - `BEST_TIME` (default):
    - Slots come from your channel's own data: the hours when past Shorts got the most views in their first 24 h.
    - Until there are about 30 published Shorts, it uses the gaming defaults for India (IST): **12:30, 18:00, 21:00**.
  - `FIXED_SLOTS`: you type the times, e.g. `13:00, 19:00, 22:00`.
  - `IMMEDIATE`: today's behaviour.
- **Other settings:**
  - Time zone.
  - Slots per day.
  - Days to skip.
  - Spread one stream's Shorts across days (don't post 10 from the same stream on one day).
- **Publish calendar page:** a week view of scheduled Shorts. Drag a Short to another slot, or press "Publish now".
- **Instagram follows the same slot** (in `WITH_YOUTUBE` mode it posts when the YouTube Short goes public).

**Data:**
- `publishing.timingMode`, `publishing.slots[]`, `publishing.spreadPerSource`.
- Clip `scheduledPublishAt` is reused.

**Done when:**
- Approved Shorts get slots automatically and appear in the calendar.
- They go Public at the slot time on YouTube.
- Moving a Short in the calendar updates YouTube.

---

## Phase 9: Autopilot (no clicks)

**Goal:** from "streamer went live" to "Short published on YouTube and Instagram" with no manual step.

**Flow:** detect → download → transcribe → pick → render → title → **quality gate** → schedule (Phase 8) → YouTube → Instagram.

**What changes:**
- **One switch "Autopilot"** in Settings, plus a per-streamer override (on, off, or follow Settings).
- **Quality gate.** A Short is published automatically only if:
  - its score is ≥ the threshold (default 75);
  - its length is within limits;
  - it isn't a duplicate (same moment, or more than 50% overlap with a published one);
  - it doesn't fall mostly on static screens;
  - its title has passed the safety check.

  Shorts below the gate wait in Clip Studio as "Needs review".
- **Caps:**
  - Max Shorts per day (YouTube and Instagram separately).
  - Max per source per day.
  - Monthly AI budget (already exists).
- **Safety net:**
  - A Telegram message for each autopilot publish, with "Unpublish" and "Pause autopilot" links.
  - Autopilot pauses itself on repeated failures or an expired token, and alerts you.
- **Activity log:** a page listing every automatic decision and its reason ("published: score 88", "held: score 61 < 75").

**Done when:** a new stream produces published Shorts with zero clicks, and low-score Shorts are held for review.

---

## Phase 10: Categories and presets

**Goal:** each kind of content automatically gets the edit and publish style that suits it.

**What changes:**
- **Categories:** Gaming, IRL/Reactions, Podcast/Talk, Sports, Comedy, Music, Education, Other.
  - The AI suggests one from the title and transcript; you can change it.
  - Set per streamer, and per video (Phase 11).
- **Preset per category:**
  - Layout (split, gameplay, dynamic from Phase 12, blur-fit).
  - Caption style; hook on or off.
  - Edit style (Phase 12); clip length.
  - Hashtags and description footer.
  - Publish slots (Phase 8); playlist.
- **Defaults:** Gaming uses split + STREAMER captions; Podcast uses face close-up + CLEAN captions; IRL uses a dynamic edit.
- **Playlists:** each category adds its Shorts to its own YouTube playlist automatically. Playlists rank in search too.
- **Stats by category** on the dashboard (views, Shorts, growth), the basis for Phase 14.

**Done when:** changing a category changes how its next Shorts look and where they go, with no other settings touched.

---

## Phase 11: Any YouTube video ("Video clipper")

**Goal:** make Shorts from any video link, not only live streams.

**What changes:**
- **"Add video" page:**
  - Paste a YouTube link.
  - Choose the category (or let the AI pick).
  - Set how many Shorts (default 2–3).
  - Switches for **hook** and **captions** (both optional).
  - A permission/licence note.
- **Moment finder for general videos.** Streams rely on chat and talk; general videos also need:
  - **Scene changes** (FFmpeg `scdet`).
  - **Loudness peaks** (exists).
  - **Motion energy**.
  - **AI scoring** of the transcript, or of frames when there is little speech (music or action videos).
- Results go through the same render, review, autopilot and publish steps.
- **Credit line** with the original video and channel in the description (as for streams).
- Videos are a new source type next to streams, so delete/purge and storage cleanup work the same way.

**Done when:** pasting a link produces 2–3 good Shorts with the category's style, published via the normal flow.

---

## Phase 12: Viral-style dynamic editing (multi-angle cuts)

**Goal:** Shorts that look hand-edited instead of one fixed crop. Different crops, zooms and cuts inside one clip, like viral clip pages.

**How it works:**
1. **Analyse the clip.** For each moment, work out:
   - where the faces and people are (detector run on sampled frames);
   - where the motion is;
   - the scene changes;
   - the loudness peaks;
   - the pauses.
2. **Build an edit plan.** A list of shots, each with: start, end, crop box (left, right, top, bottom, face close-up, wide), zoom, transition, effect.
3. **Render the plan** with FFmpeg (one filter graph per shot, then join).

**Editing moves:**
- Cut between crops (e.g. wide → face close-up when the person reacts → right side where the action is).
- **Punch-in zoom** on the key moment (1.0× → 1.3× in 0.3 s).
- **Split screen** (two regions stacked) when two things happen at once.
- **Jump cuts** that remove pauses and dead air.
- Optional **shake or flash** on the loudest moment, and **freeze-frame + zoom** on a reaction.

**Settings:**
- Edit style `CALM` (few cuts), `DYNAMIC` or `HYPER` (a cut every 1–2 s), per category (Phase 10).

**Clip Studio:**
- Shows the shot list on a timeline.
- Change a shot's crop, remove an effect, then re-render.

**Done when:**
- The DYNAMIC style produces clips with at least 3 different framings that follow the action/face.
- The audio stays in sync after jump cuts.
- Captions still line up after the cuts.

---

## Phase 13: Clipping while the stream is live

**Goal:** publish a Short of a big moment within about 15–20 minutes, while the stream is still trending.

**How it works:**
- When a streamer goes live, a **live recorder** saves the stream in 10-minute pieces (yt-dlp live download).
- Each piece goes through:
  - transcription (local Parakeet);
  - scoring with chat spike + loudness (both already sampled live).
- A moment above a high threshold (default 85) is rendered immediately and goes through autopilot (Phase 9).
- After the stream ends, the normal full pass runs and **skips moments already clipped**.

**Settings:**
- Per streamer: live clipping on/off, max live Shorts per stream, live threshold.

**Resources:** about 1 CPU core per live streamer for recording + transcription. The worker limits how many live streams are clipped at once.

**Done when:** during a real live stream, a high-scoring moment appears as a rendered Short within 20 minutes, and the post-stream pass doesn't duplicate it.

---

## Phase 14: Learning loop

**Goal:** the app learns what works on *your* channel.

**What changes:**
- **Daily job.** Compare each published Short's results (views at 24 h and 7 d, likes, comments; retention if the YouTube Analytics scope is added) with its features:
  - score parts, hook;
  - length, category, layout, edit style;
  - publish time, source.
- **Feed the winners back into:**
  - the AI prompt (examples of your top hooks and moments);
  - the score weights (AI / audio / chat);
  - the default clip length per category;
  - the best publish slots (Phase 8 `BEST_TIME`);
  - the autopilot threshold.
- **"What's working" page:** best category, best hour, best length, best hook style, with trends.
- **Guard rails:** changes are small and gradual, and you can lock any setting so the loop doesn't change it.

**Done when:** after about 30+ published Shorts, slots and weights update themselves, and the page explains why.

---

## How we'll work through it

- One branch and one PR per phase, merged before the next one starts.
- Each phase ends with:
  - tests;
  - a README section;
  - a real end-to-end run on a stream or video;
  - a short demo note.
- After each phase, you review the result, and we adjust the next phase before starting it.

**Next step:** confirm the order (or change it), settle the three "before Phase 8" items, and Phase 8 starts.
