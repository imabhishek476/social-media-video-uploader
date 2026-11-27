import { fileURLToPath } from 'node:url';
import type { TranscriptSegment } from '@shorts/integrations';

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  primaryColor: string; // #RRGGBB
  highlightColor: string; // #RRGGBB
  position: 'BOTTOM' | 'MIDDLE' | 'TOP';
  /** Words shown at once (short-form: 2-4). */
  maxWords?: number;
  /** Scale (%) of the word being spoken; 100 = no pop. */
  popScale?: number;
  uppercase?: boolean;
  /** Vertical centre (px of 1920) for the caption line; overrides `position` (used by split layouts). */
  anchorY?: number | null;
  /** Soft coloured glow around the words instead of a hard outline. */
  glow?: boolean;
}

export type CaptionPreset = 'STREAMER' | 'HYPE' | 'BOUNCE' | 'CLEAN' | 'CUSTOM';

/**
 * Ready-made caption looks (fonts bundled in packages/core/fonts, SIL OFL):
 * HYPE: huge condensed Anton, 2 words, red; BOUNCE: Poppins ExtraBold, 3 words,
 * cyan; CLEAN: smaller Poppins, 4 words, normal case. CUSTOM uses Settings as is.
 */
export function presetStyle(preset: CaptionPreset, base: CaptionStyle): CaptionStyle {
  switch (preset) {
    case 'STREAMER':
      // Clip-channel look: medium bold caps, white with a soft glow, spoken word in yellow.
      return { ...base, fontFamily: 'Poppins ExtraBold', fontSize: 92, primaryColor: '#FFFFFF', highlightColor: '#FFE14D', maxWords: 3, popScale: 104, uppercase: true, glow: true };
    case 'HYPE':
      return { ...base, fontFamily: 'Anton', fontSize: 150, primaryColor: '#FFFFFF', highlightColor: '#FF3B3B', maxWords: 2, popScale: 114, uppercase: true };
    case 'BOUNCE':
      return { ...base, fontFamily: 'Poppins ExtraBold', fontSize: 128, primaryColor: '#FFFFFF', highlightColor: '#22F0FF', maxWords: 3, popScale: 112, uppercase: true };
    case 'CLEAN':
      return { ...base, fontFamily: 'Poppins ExtraBold', fontSize: 96, primaryColor: '#FFFFFF', highlightColor: '#9FD4FF', maxWords: 4, popScale: 106, uppercase: false };
    default:
      return { maxWords: MAX_WORDS, popScale: 100, uppercase: true, ...base };
  }
}

export interface HookOverlay {
  text: string;
  /** INTRO = first seconds only; ALWAYS = whole clip. */
  mode: 'INTRO' | 'ALWAYS';
}

/** Our own reaction line (originality layer): a yellow sticker shown from `fromSeconds` to the end. */
export interface ReactionSticker {
  text: string;
  fromSeconds: number;
  /** Where it sits: top (where the hook was) or above the bottom Shorts UI. */
  at: 'TOP' | 'BOTTOM';
}

/** Fonts bundled with the renderer (passed to libass as fontsdir). */
export const FONTS_DIR = fileURLToPath(new URL('../fonts', import.meta.url));

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

const WIDTH = 1080;
const HEIGHT = 1920;
/** Short-form captions: a few words at a time, read at a glance. */
const MAX_WORDS = 3;
const MAX_CHARS = 18;

/** `#RRGGBB` → ASS `&H00BBGGRR` (ASS colours are little-endian with alpha first). */
export function assColor(hex: string): string {
  const h = hex.replace('#', '');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** The burned-in fonts have no emoji glyphs (they'd show as boxes), so drop emoji. */
export const noEmoji = (t: string) => t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();

/** Neutralise ASS override syntax in transcript text. */
const assText = (t: string) => t.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Word timings for captions. Uses the exact per-word times from the
 * transcription provider when present; otherwise words are spread across
 * their segment in proportion to their length (older transcripts).
 */
export function wordsFromSegments(segments: TranscriptSegment[], clipStart: number, clipEnd: number): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of segments) {
    if (seg.endSeconds <= clipStart || seg.startSeconds >= clipEnd) continue;
    if (seg.words?.length) {
      for (const w of seg.words) {
        const text = assText(w.word);
        if (!text || w.endSeconds <= clipStart || w.startSeconds >= clipEnd) continue;
        out.push({ text, start: Math.max(w.startSeconds, clipStart) - clipStart, end: Math.min(w.endSeconds, clipEnd) - clipStart });
      }
      continue;
    }
    const words = assText(seg.text).split(' ').filter(Boolean);
    if (!words.length) continue;
    const span = Math.max(0.2, seg.endSeconds - seg.startSeconds);
    const weights = words.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = seg.startSeconds;
    words.forEach((w, i) => {
      const d = (span * weights[i]!) / total;
      const start = t;
      const end = t + d;
      t = end;
      if (end <= clipStart || start >= clipEnd) return;
      out.push({ text: w, start: Math.max(start, clipStart) - clipStart, end: Math.min(end, clipEnd) - clipStart });
    });
  }
  return out;
}

/** Group words into short caption lines, breaking at punctuation and pauses. */
function chunk(words: TimedWord[], maxWords = MAX_WORDS): TimedWord[][] {
  const lines: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const gap = cur.length ? w.start - cur[cur.length - 1]!.end : 0;
    if (cur.length && (cur.length >= maxWords || len > Math.max(MAX_CHARS, maxWords * 6) || gap > 0.6)) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.!?,;:]$/.test(w.text)) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * Animated word-by-word captions as an ASS file for a 1080×1920 Short
 * (times relative to the clip start). Each word lights up in the highlight
 * colour while it is spoken.
 */
export function buildAssCaptions(segments: TranscriptSegment[], clipStart: number, clipEnd: number, style: CaptionStyle, hook?: HookOverlay | null, reaction?: ReactionSticker | null): string {
  // Keep captions clear of the YouTube Shorts UI at the top and bottom.
  const [alignment, marginV] = style.anchorY ? [5, 0] : style.position === 'TOP' ? [8, 260] : style.position === 'BOTTOM' ? [2, 420] : [5, 0];
  const place = style.anchorY ? `{\\pos(${WIDTH / 2},${Math.round(style.anchorY)})}` : '';
  const glowTags = style.glow ? `{\\3c&H00F0E6A0&\\3a&H60&\\blur5}` : '';
  const outline = style.glow ? Math.max(4, Math.round(style.fontSize / 11)) : Math.max(3, Math.round(style.fontSize / 12));
  const primary = assColor(style.primaryColor);
  const highlight = assColor(style.highlightColor);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${style.fontFamily},${style.fontSize},${primary},${highlight},&H00000000,&H80000000,-1,0,0,0,100,100,${style.glow ? 2 : 0},0,1,${outline},${style.glow ? 0 : 2},${alignment},80,80,${marginV},1`,
    // Hook: dark text on a white box at the top, clear of the Shorts UI.
    // Reaction: our own comment on a yellow sticker.
    `Style: Reaction,Poppins ExtraBold,58,&H00141414,&H00141414,&H0033D6FF,&H0033D6FF,-1,0,0,0,100,100,0,0,3,16,0,${reaction?.at === 'BOTTOM' ? 2 : 8},90,90,${reaction?.at === 'BOTTOM' ? 430 : 250},1`,
    `Style: Hook,Poppins ExtraBold,76,&H00141414,&H00141414,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,18,0,8,90,90,${style.position === 'TOP' ? 620 : 250},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events: string[] = [];
  const up = (t: string) => (style.uppercase === false ? t : t.toUpperCase());
  const pop = style.popScale && style.popScale !== 100 ? style.popScale : null;
  for (const line of chunk(wordsFromSegments(segments, clipStart, clipEnd), style.maxWords)) {
    line.forEach((w, i) => {
      // Each word's event lasts until the next word starts, so the line never flickers.
      const end = i < line.length - 1 ? line[i + 1]!.start : w.end;
      if (end - w.start < 0.02) return;
      // The spoken word lights up and "pops" (scales up, then settles slightly larger).
      const hiGlow = style.glow ? `\\3c${highlight}` : '';
      const loGlow = style.glow ? `\\3c&H00F0E6A0&` : '';
      const on = pop ? `{\\c${highlight}${hiGlow}\\fscx${pop + 8}\\fscy${pop + 8}\\t(0,120,\\fscx${pop}\\fscy${pop})}` : `{\\c${highlight}${hiGlow}}`;
      const off = pop ? `{\\c${primary}${loGlow}\\fscx100\\fscy100}` : `{\\c${primary}${loGlow}}`;
      const text = line.map((x, j) => (j === i ? `${on}${up(x.text)}${off}` : up(x.text))).join(' ');
      events.push(`Dialogue: 0,${assTime(w.start)},${assTime(end)},Caption,,0,0,0,,${place}${glowTags}${text}`);
    });
  }
  const hookText = hook ? hookLines(hook.text) : '';
  if (hookText) {
    const until = hook!.mode === 'ALWAYS' ? clipEnd - clipStart : Math.min(4, clipEnd - clipStart);
    events.unshift(`Dialogue: 1,${assTime(0)},${assTime(until)},Hook,,0,0,0,,{\\fad(150,200)}${hookText}`);
  }
  const reactionText = reaction ? noEmoji(assText(reaction.text)).slice(0, 80) : '';
  if (reactionText && clipEnd - clipStart > reaction!.fromSeconds + 1) {
    events.push(`Dialogue: 2,${assTime(reaction!.fromSeconds)},${assTime(clipEnd - clipStart)},Reaction,,0,0,0,,{\\fad(200,0)}${reactionText}`);
  }
  return [...header, ...events, ''].join('\n');
}

/** Upper-case hook, at most ~6 words, wrapped onto two balanced lines. */
export function hookLines(text: string): string {
  const words = noEmoji(assText(text)).replace(/["“”]/g, '').toUpperCase().split(' ').filter(Boolean).slice(0, 7);
  if (!words.length) return '';
  const joined = words.join(' ');
  if (joined.length <= 16) return joined;
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return `${words.slice(0, best).join(' ')}\\N${words.slice(best).join(' ')}`;
}
