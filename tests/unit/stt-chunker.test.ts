import { describe, expect, it } from 'vitest';
import { chunkTokensToCues, chunkTokensToSrt, CUE_MAX_CHARS, CUE_MAX_MS, CUE_MIN_MS, formatSrtTime, tokensToWords } from '@/lib/parsing/stt-chunker';
import { parseSrtCues } from '@/lib/parsing/srt';
import type { SonioxToken } from '@/lib/providers/adapters/soniox-types';
import { SAMPLE_TOKENS } from '../mocks/soniox-mock';

const tok = (text: string, start_ms: number, end_ms: number, speaker?: string): SonioxToken => ({ text, start_ms, end_ms, confidence: 1, ...(speaker ? { speaker } : {}) });

/** Chuỗi từ đều nhau: mỗi từ 200 ms, cách nhau `gap` ms. */
function words(list: string[], gap = 50): SonioxToken[] {
  let t = 0;
  return list.map((w, i) => {
    const s = t;
    t += 200 + gap;
    return tok(i === 0 ? w : ` ${w}`, s, s + 200);
  });
}

describe('stt-chunker (spec 004, FR-004)', () => {
  it('ghép token dưới-từ thành từ theo khoảng trắng đầu token', () => {
    const w = tokensToWords([tok('Hel', 0, 90), tok('lo', 110, 160), tok(' world', 200, 400), tok('.', 400, 410)]);
    expect(w.map((x) => x.text)).toEqual(['Hello', 'world.']);
    expect(w[0]).toMatchObject({ startMs: 0, endMs: 160 });
  });

  it('ngắt cue sau dấu kết câu và định dạng mốc HH:MM:SS,mmm --> HH:MM:SS,mmm', () => {
    const cues = chunkTokensToCues(SAMPLE_TOKENS);
    expect(cues.map((c) => c.text)).toEqual(['Xin chào các bạn.', 'Hôm nay chúng ta học bài mới.', 'Vâng, cảm ơn thầy.']);
    const srt = chunkTokensToSrt(SAMPLE_TOKENS);
    expect(srt).toMatch(/^1\n00:00:00,120 --> 00:00:01,320\nXin chào các bạn\.\n/);
    // Đọc lại được bằng bộ phân tích .srt của hệ thống (tương thích chế độ khớp mốc, spec 003)
    const parsed = parseSrtCues(srt);
    expect(parsed.cues).toHaveLength(3);
    expect(parsed.warningCount).toBe(0);
  });

  it('ngắt khi khoảng lặng giữa hai từ ≥ 380 ms, không ngắt khi < 380 ms', () => {
    expect(chunkTokensToCues([tok('một', 0, 200), tok(' hai', 579, 800)])).toHaveLength(1);
    expect(chunkTokensToCues([tok('một', 0, 200), tok(' hai', 580, 800)])).toHaveLength(2);
  });

  it('mỗi cue tối đa 75 ký tự và 5,5 giây', () => {
    const cues = chunkTokensToCues(words(Array.from({ length: 80 }, (_, i) => `từ${i}`), 20));
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) {
      expect([...c.text].length).toBeLessThanOrEqual(CUE_MAX_CHARS);
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(CUE_MAX_MS);
    }
  });

  it('kéo dài cue ngắn tới 1,2 giây nhưng không chồng lên cue sau', () => {
    const cues = chunkTokensToCues([tok('Ừ.', 0, 300), tok(' Được.', 3000, 3400), tok(' Ok.', 3500, 3700)]);
    expect(cues[0]!.endMs - cues[0]!.startMs).toBe(CUE_MIN_MS);
    expect(cues[1]!.endMs).toBeLessThanOrEqual(cues[2]!.startMs);
  });

  it('ngắt cue khi đổi người nói', () => {
    const cues = chunkTokensToCues([tok('A', 0, 200, '1'), tok(' B', 250, 400, '2')]);
    expect(cues.map((c) => c.speaker)).toEqual(['1', '2']);
  });

  it('bỏ token sự kiện âm thanh và token bản dịch', () => {
    const cues = chunkTokensToCues([
      tok('Chào', 0, 200),
      { ...tok(' [nhạc]', 210, 900), is_audio_event: true },
      { ...tok(' Hello', 210, 400), translation_status: 'translation' },
    ]);
    expect(cues.map((c) => c.text)).toEqual(['Chào']);
  });

  it('formatSrtTime', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(3_723_004)).toBe('01:02:03,004');
  });
});
