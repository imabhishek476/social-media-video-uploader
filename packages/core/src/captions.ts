import type { TranscriptSegment } from '@shorts/integrations';

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  primaryColor: string; // #RRGGBB
  highlightColor: string; // #RRGGBB
  position: 'BOTTOM' | 'MIDDLE' | 'TOP';
}

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

/** Neutralise ASS override syntax in transcript text. */
const assText = (t: string) => t.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Word timings within a segment. Whisper gives segment times; words are
 * spread across the segment in proportion to their length, which is close
 * enough for word-by-word highlighting.
 */
export function wordsFromSegments(segments: TranscriptSegment[], clipStart: number, clipEnd: number): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of segments) {
    if (seg.endSeconds <= clipStart || seg.startSeconds >= clipEnd) continue;
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
function chunk(words: TimedWord[]): TimedWord[][] {
  const lines: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    const gap = cur.length ? w.start - cur[cur.length - 1]!.end : 0;
    if (cur.length && (cur.length >= MAX_WORDS || len > MAX_CHARS || gap > 0.6)) {
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
export function buildAssCaptions(segments: TranscriptSegment[], clipStart: number, clipEnd: number, style: CaptionStyle): string {
  // Keep captions clear of the YouTube Shorts UI at the top and bottom.
  const [alignment, marginV] = style.position === 'TOP' ? [8, 260] : style.position === 'BOTTOM' ? [2, 420] : [5, 0];
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
    `Style: Caption,${style.fontFamily},${style.fontSize},${primary},${highlight},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(3, Math.round(style.fontSize / 12))},2,${alignment},80,80,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events: string[] = [];
  for (const line of chunk(wordsFromSegments(segments, clipStart, clipEnd))) {
    line.forEach((w, i) => {
      // Each word's event lasts until the next word starts, so the line never flickers.
      const end = i < line.length - 1 ? line[i + 1]!.start : w.end;
      if (end - w.start < 0.02) return;
      const text = line.map((x, j) => (j === i ? `{\\c${highlight}}${x.text.toUpperCase()}{\\c${primary}}` : x.text.toUpperCase())).join(' ');
      events.push(`Dialogue: 0,${assTime(w.start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    });
  }
  return [...header, ...events, ''].join('\n');
}
