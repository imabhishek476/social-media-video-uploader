import { describe, expect, it } from 'vitest';
import { buildAssCaptions, hookLines, parseFreezes, presetStyle, staticShare, videoFilter, captionAnchor } from '../src';

const base = { fontFamily: 'Montserrat', fontSize: 84, primaryColor: '#FFFFFF', highlightColor: '#FFD400', position: 'MIDDLE' as const };
const seg = [{ startSeconds: 10, endSeconds: 12, text: 'no way bro', words: [
  { word: 'no', startSeconds: 10, endSeconds: 10.4 }, { word: 'way', startSeconds: 10.4, endSeconds: 10.9 }, { word: 'bro', startSeconds: 11, endSeconds: 11.6 },
] }];

describe('caption presets and hook overlay', () => {
  it('HYPE shows two big words at a time with a pop on the spoken one', () => {
    const ass = buildAssCaptions(seg, 10, 20, presetStyle('HYPE', base));
    expect(ass).toContain('Style: Caption,Anton,150,');
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0'));
    expect(lines[0]).toMatch(/\\fscx122\\fscy122\\t\(0,120,\\fscx114\\fscy114\)\}NO\{.*\} WAY$/);
    expect(lines[2]).toContain('BRO'); // third word starts a new two-word line
    expect(lines[2]).not.toContain('WAY');
  });

  it('CUSTOM keeps the Settings font and no pop; CLEAN keeps normal case', () => {
    expect(buildAssCaptions(seg, 10, 20, presetStyle('CUSTOM', base))).not.toContain('fscx');
    expect(buildAssCaptions(seg, 10, 20, presetStyle('CLEAN', base))).toContain('}no{');
  });

  it('draws the hook in a box at the top for the whole clip or the intro', () => {
    const always = buildAssCaptions(seg, 10, 40, presetStyle('HYPE', base), { text: 'what the f*** was that?!', mode: 'ALWAYS' });
    expect(always).toMatch(/Dialogue: 1,0:00:00.00,0:00:30.00,Hook,,0,0,0,,\{\\fad\(150,200\)\}WHAT THE F\*\*\*\\NWAS THAT\?!/);
    const intro = buildAssCaptions([], 10, 40, presetStyle('HYPE', base), { text: 'CLUTCH', mode: 'INTRO' });
    expect(intro).toContain('0:00:00.00,0:00:04.00,Hook');
    expect(hookLines('1 VS 3')).toBe('1 VS 3');
    expect(hookLines('{\\b1}')).not.toMatch(/[{}\\]/);
  });
});

describe('gameplay layout', () => {
  it('fills the frame with the game and overlays the bordered webcam', () => {
    const f = videoFilter('GAMEPLAY', '/tmp/c.ass', { x: 0, y: 0.4, w: 0.2, h: 0.2 }, '/fonts');
    expect(f).toContain("[gamesrc]crop=w='min(iw,ih*9/16)'");
    expect(f).toContain('pad=iw+12:ih+12:6:6:color=0x22F0FF[cam]');
    expect(f).toContain('[game][cam]overlay=40:470');
    expect(f).toContain('ass=filename=/tmp/c.ass:fontsdir=/fonts');
  });
});

describe('static ranges', () => {
  it('parses ffmpeg freezedetect output and measures overlap', () => {
    const log = 'x lavfi.freezedetect.freeze_start: 100\nfreeze_duration: 30\nlavfi.freezedetect.freeze_end: 130.04\nlavfi.freezedetect.freeze_start: 500';
    const r = parseFreezes(log);
    expect(r[0]).toEqual([100, 130]);
    expect(r[1]![0]).toBe(500);
    expect(staticShare(r, 110, 130)).toBe(1);
    expect(staticShare(r, 90, 110)).toBe(0.5);
    expect(staticShare(r, 200, 300)).toBe(0);
  });
});

describe('streamer captions and layout-aware placement', () => {

  it('puts captions on the split seam and in the lower third for gameplay, never the centre', () => {
    expect(captionAnchor('FACECAM_SPLIT', 'MIDDLE')).toBeLessThan(900);
    expect(captionAnchor('FACECAM_SPLIT', 'MIDDLE')).toBeGreaterThan(820);
    expect(captionAnchor('GAMEPLAY', 'MIDDLE')).toBeGreaterThan(1300);
    expect(captionAnchor('GAMEPLAY', 'TOP')).toBeNull();
  });

  it('STREAMER preset glows and is positioned with \\pos', () => {
    const style = { ...presetStyle('STREAMER', base), anchorY: 876 };
    const ass = buildAssCaptions(seg, 10, 20, style);
    expect(ass).toContain('Poppins ExtraBold,92');
    expect(ass).toContain('\\pos(540,876)');
    expect(ass).toContain('\\blur5');
  });

  it('split layout draws the white divider', () => {
    expect(videoFilter('FACECAM_SPLIT', null, { x: 0, y: 0, w: 0.2, h: 0.2 })).toContain('drawbox=x=0:y=896');
  });
});
