import type { RenderMode } from './render';

/** Phase 8.6: the look of a Short, chosen per moment. */
export const SHORT_STYLES = ['REACTION', 'GAMEPLAY', 'CLEAN', 'STORY'] as const;
export type ShortStyle = (typeof SHORT_STYLES)[number];
export type StyleSetting = ShortStyle | 'AUTO';
export type MomentType = 'reaction' | 'action' | 'story';

export const STYLE_LABELS: Record<ShortStyle, string> = {
  REACTION: 'Reaction',
  GAMEPLAY: 'Gameplay',
  CLEAN: 'Clean gameplay',
  STORY: 'Story',
};

/** Below this, the moment is mostly game audio: captions would add little. */
export const QUIET_WORDS_PER_SECOND = 0.6;

export const isShortStyle = (v: unknown): v is ShortStyle => typeof v === 'string' && (SHORT_STYLES as readonly string[]).includes(v);

/** Words spoken per second inside [start, end). */
export function wordsPerSecond(segments: Array<{ startSeconds: number; endSeconds: number; text: string }>, start: number, end: number): number {
  const length = Math.max(1, end - start);
  let words = 0;
  for (const s of segments) {
    if (s.endSeconds <= start || s.startSeconds >= end) continue;
    const span = Math.max(0.1, s.endSeconds - s.startSeconds);
    const inside = Math.min(end, s.endSeconds) - Math.max(start, s.startSeconds);
    words += (s.text.trim().split(/\s+/).filter(Boolean).length * Math.max(0, inside)) / span;
  }
  return Math.round((words / length) * 100) / 100;
}

/** Auto: pick the style for one moment, with a reason a person can read. */
export function pickStyle(input: { momentType?: MomentType | null; faceVisible: boolean; wordsPerSecond: number }): { style: ShortStyle; reason: string } {
  const wps = `${input.wordsPerSecond.toFixed(1)} words/s`;
  if (input.momentType === 'story') return { style: 'STORY', reason: 'AI: a story beat' };
  if (input.wordsPerSecond < QUIET_WORDS_PER_SECOND) return { style: 'CLEAN', reason: `little talking (${wps})` };
  if (input.momentType === 'action') return { style: 'GAMEPLAY', reason: `AI: gameplay action (${wps})` };
  if (input.faceVisible) return { style: 'REACTION', reason: `streamer reacting, face visible (${wps})` };
  return { style: 'GAMEPLAY', reason: `no face in this clip (${wps})` };
}

export interface StyleLook {
  mode: RenderMode;
  /** Use the webcam box (split or corner). */
  useFacecam: boolean;
  wordCaptions: boolean;
  /** AS_SET = the hook setting; TITLE = hook for the whole Short; OFF = none. */
  hook: 'AS_SET' | 'TITLE' | 'OFF';
  reaction: boolean;
}

/** What each style renders. Without a visible face, webcam layouts fall back to full-screen gameplay. */
export function styleLook(style: ShortStyle, faceVisible: boolean): StyleLook {
  switch (style) {
    case 'REACTION':
      return faceVisible
        ? { mode: 'FACECAM_SPLIT', useFacecam: true, wordCaptions: true, hook: 'AS_SET', reaction: true }
        : { mode: 'CENTER_CROP', useFacecam: false, wordCaptions: true, hook: 'AS_SET', reaction: true };
    case 'GAMEPLAY':
      return { mode: faceVisible ? 'GAMEPLAY' : 'CENTER_CROP', useFacecam: faceVisible, wordCaptions: true, hook: 'AS_SET', reaction: true };
    case 'CLEAN':
      return { mode: 'CENTER_CROP', useFacecam: false, wordCaptions: false, hook: 'OFF', reaction: false };
    case 'STORY':
      return { mode: 'CENTER_CROP', useFacecam: false, wordCaptions: false, hook: 'TITLE', reaction: false };
  }
}
