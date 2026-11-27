import { describe, expect, it } from 'vitest';
import { pickStyle, styleLook, wordsPerSecond } from '../src/styles';

describe('Short styles (Phase 8.6)', () => {
  const seg = (startSeconds: number, endSeconds: number, text: string) => ({ startSeconds, endSeconds, text });

  it('counts words per second inside the clip only', () => {
    const segs = [seg(0, 10, 'one two three four five six seven eight nine ten'), seg(10, 20, 'a b')];
    expect(wordsPerSecond(segs, 0, 10)).toBe(1);
    expect(wordsPerSecond(segs, 5, 15)).toBe(0.6); // half of each segment: 5 + 1 words over 10 s
    expect(wordsPerSecond([], 0, 30)).toBe(0);
  });

  it('picks a style for each kind of moment', () => {
    expect(pickStyle({ momentType: 'story', faceVisible: true, wordsPerSecond: 3 }).style).toBe('STORY');
    expect(pickStyle({ momentType: 'reaction', faceVisible: true, wordsPerSecond: 0.2 }).style).toBe('CLEAN');
    expect(pickStyle({ momentType: 'action', faceVisible: true, wordsPerSecond: 2 }).style).toBe('GAMEPLAY');
    expect(pickStyle({ momentType: 'reaction', faceVisible: true, wordsPerSecond: 2 }).style).toBe('REACTION');
    const noFace = pickStyle({ momentType: 'reaction', faceVisible: false, wordsPerSecond: 2 });
    expect(noFace.style).toBe('GAMEPLAY');
    expect(noFace.reason).toContain('no face');
    expect(pickStyle({ faceVisible: true, wordsPerSecond: 2 }).style).toBe('REACTION');
  });

  it('never uses a webcam layout without a visible face', () => {
    expect(styleLook('REACTION', true)).toMatchObject({ mode: 'FACECAM_SPLIT', useFacecam: true });
    expect(styleLook('REACTION', false)).toMatchObject({ mode: 'CENTER_CROP', useFacecam: false });
    expect(styleLook('GAMEPLAY', false)).toMatchObject({ mode: 'CENTER_CROP', useFacecam: false });
  });

  it('clean gameplay has no captions, hook or sticker; story keeps only a title', () => {
    expect(styleLook('CLEAN', true)).toMatchObject({ wordCaptions: false, hook: 'OFF', reaction: false, useFacecam: false });
    expect(styleLook('STORY', true)).toMatchObject({ wordCaptions: false, hook: 'TITLE', reaction: false });
  });
});
