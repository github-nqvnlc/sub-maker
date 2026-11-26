import { describe, expect, it } from 'vitest';
import type { SonioxToken } from '@/lib/providers/adapters/soniox-types';
import { segmentCues, toClusters, type DraftCue } from '@/lib/video/segmentation';

/** Token → cụm → cue (spec 006, T027; contracts/subtitle-pipeline.md §1–§2; FR-014, FR-015, FR-018). */

type Status = SonioxToken['translation_status'];
const tok = (text: string, start_ms: number, end_ms: number, over: Partial<SonioxToken> = {}): SonioxToken => ({ text, start_ms, end_ms, confidence: 0.9, ...over });

/** Dựng một cụm: lời gốc có mốc, theo sau là lời dịch không mốc. `from`/`to` chia đều cho các từ gốc. */
function cluster(source: string, target: string | null, from: number, to: number, over: Partial<SonioxToken> = {}): SonioxToken[] {
  const words = source.split(' ');
  const step = (to - from) / words.length;
  const original: SonioxToken[] = words.map((w, i) => tok(` ${w}`, Math.round(from + i * step), Math.round(from + (i + 1) * step), { translation_status: target === null ? 'none' : 'original', language: 'en', ...over }));
  const translation: SonioxToken[] = (target ?? '').split(' ').filter(Boolean).map((w) => tok(` ${w}`, 0, 0, { translation_status: 'translation' as Status, language: 'vi' }));
  return [...original, ...translation];
}

const squash = (s: string) => s.normalize('NFC').replace(/\s+/gu, '');
const words = (s: string) => s.split(/\s+/u).filter(Boolean);

/** Bất biến của hợp đồng: không mất chữ, mốc tăng dần không chồng, đủ dài, đúng giới hạn, tất định. */
function expectInvariants(tokens: SonioxToken[], cues: DraftCue[], durationMs: number) {
  const speech = tokens.filter((t) => !t.is_audio_event);
  expect(squash(cues.map((c) => c.targetText).join(''))).toBe(squash(speech.filter((t) => t.translation_status === 'translation' || t.translation_status === 'none').map((t) => t.text).join('')));
  expect(squash(cues.map((c) => c.sourceText).join(''))).toBe(squash(speech.filter((t) => t.translation_status !== 'translation').map((t) => t.text).join('')));
  let prev = 0;
  for (const c of cues) {
    expect(c.startMs).toBeGreaterThanOrEqual(prev);
    expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(100);
    expect(c.endMs).toBeLessThanOrEqual(durationMs);
    prev = c.endMs;
    const shown = c.targetText || c.sourceText;
    const lines = shown.split('\n');
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) {
      if (/[぀-ヿ㐀-鿿฀-๿]/u.test(line) && !line.includes(' ')) expect([...line].length).toBeLessThanOrEqual(42);
      else expect(words(line).length).toBeLessThanOrEqual(12);
    }
  }
  expect(segmentCues(tokens, { durationMs })).toEqual(cues);
}

const run = (tokens: SonioxToken[], durationMs = 600_000) => {
  const cues = segmentCues(tokens, { durationMs });
  expectInvariants(tokens, cues, durationMs);
  return cues;
};

describe('token → cụm', () => {
  it('gom lời gốc và lời dịch đi liền sau; bỏ sự kiện âm thanh; mốc lấy từ lời gốc', () => {
    const tokens = [
      tok(' Hel', 1000, 1200, { translation_status: 'original' }),
      tok('lo', 1200, 1400, { translation_status: 'original' }),
      tok(' world', 1500, 1900, { translation_status: 'original' }),
      tok(' (applause)', 1900, 2400, { is_audio_event: true }),
      tok(' Xin', 0, 0, { translation_status: 'translation' }),
      tok(' chào', 0, 0, { translation_status: 'translation' }),
      tok(' How', 3000, 3200, { translation_status: 'original' }),
      tok(' Bạn', 0, 0, { translation_status: 'translation' }),
    ];
    const clusters = toClusters(tokens);
    expect(clusters.map((c) => [c.source.trim(), c.target.trim(), c.startMs, c.endMs])).toEqual([
      ['Hello world', 'Xin chào', 1000, 1900],
      ['How', 'Bạn', 3000, 3200],
    ]);
    expect(clusters[0]!.sourceWords.map((w) => [w.text.trim(), w.startMs, w.endMs])).toEqual([
      ['Hello', 1000, 1400],
      ['world', 1500, 1900],
    ]);
  });

  it('đổi người nói thì sang cụm mới; thiếu translation_status coi là lời gốc', () => {
    const tokens = [tok(' A', 0, 100, { speaker: '1' }), tok(' B', 200, 300, { speaker: '2' }), tok(' b', 0, 0, { translation_status: 'translation' })];
    expect(toClusters(tokens).map((c) => [c.source.trim(), c.target.trim(), c.speaker])).toEqual([
      ['A', '', '1'],
      ['B', 'b', '2'],
    ]);
    expect(toClusters(tokens)[0]).toMatchObject({ untranslated: true, sameLanguage: false });
  });

  it('đoạn đã ở ngôn ngữ đích: câu dịch lấy nguyên câu gốc', () => {
    const [c] = toClusters(cluster('Chào cả nhà', null, 0, 900, { language: 'vi' }));
    expect(c).toMatchObject({ sameLanguage: true, untranslated: false });
    expect(c!.target.trim()).toBe('Chào cả nhà');
  });

  it('dãy dịch đứng đầu (chưa có lời gốc) không bị mất', () => {
    const tokens = [tok(' Mở', 0, 0, { translation_status: 'translation' }), ...cluster('Open the door.', 'cửa ra.', 500, 1500)];
    expect(toClusters(tokens)).toHaveLength(1);
    expect(toClusters(tokens)[0]!.target.trim()).toBe('Mở cửa ra.');
    expect(run(tokens).map((c) => c.targetText)).toEqual(['Mở cửa ra.']);
  });

  it('chữ được chuẩn hóa NFC kể cả khi dấu nằm ở token khác', () => {
    const tokens = [tok(' a', 0, 200, { translation_status: 'original' }), tok(' Tie', 0, 0, { translation_status: 'translation' }), tok('̂́ng', 0, 0, { translation_status: 'translation' })];
    expect(run(tokens)[0]!.targetText).toBe('Tiếng');
  });
});

describe('cụm → câu → cue', () => {
  it('ngắt tại dấu kết câu, đổi người nói và quãng nghỉ trên 300 ms; mốc đo thật', () => {
    const tokens = [
      ...cluster('Hello there.', 'Xin chào bạn.', 1000, 2000, { speaker: '1' }),
      ...cluster('We start', 'Chúng ta bắt đầu', 2100, 2900, { speaker: '1' }),
      ...cluster('now', 'ngay bây giờ', 3000, 3400, { speaker: '1' }),
      ...cluster('after a break', 'sau giờ nghỉ', 3800, 4600, { speaker: '1' }),
      ...cluster('me too', 'tôi cũng vậy', 4700, 5300, { speaker: '2' }),
    ];
    const cues = run(tokens);
    expect(cues.map((c) => c.targetText)).toEqual(['Xin chào bạn.', 'Chúng ta bắt đầu ngay bây giờ', 'sau giờ nghỉ', 'tôi cũng vậy']);
    expect(cues.map((c) => c.sourceText)).toEqual(['Hello there.', 'We start now', 'after a break', 'me too']);
    expect(cues.map((c) => c.timing)).toEqual(['measured', 'measured', 'measured', 'measured']);
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 2000],
      [2100, 3400],
      [3800, 4600],
      [4700, 5400], // kéo dài đủ 700 ms
    ]);
    expect(cues.map((c) => c.speaker)).toEqual(['1', '1', '1', '2']);
    expect(cues[0]!.sourceLang).toBe('en');
  });

  it('khoảng nghỉ đúng 300 ms vẫn chung câu; dấu kết câu toàn rộng cũng ngắt', () => {
    expect(run([...cluster('a', 'một', 0, 500), ...cluster('b', 'hai', 800, 1500)])).toHaveLength(1);
    expect(run([...cluster('a', 'một。', 0, 800), ...cluster('b', 'hai', 900, 1700)])).toHaveLength(2);
  });

  it('câu dài quá 7 giây thì ngắt ở ranh giới cụm', () => {
    const tokens = Array.from({ length: 6 }, (_, i) => cluster(`w${i}`, `từ ${i}`, i * 2000, i * 2000 + 1900)).flat();
    const cues = run(tokens);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(c.endMs - c.startMs).toBeLessThanOrEqual(9000);
  });

  it('câu vượt 24 từ cắt tại ranh giới cụm gần nhất có dấu ngắt nhịp, mốc vẫn là mốc đo', () => {
    const part = (n: number, tail = '') => `${Array.from({ length: n }, (_, i) => `chữ${i}`).join(' ')}${tail}`;
    const tokens = [
      ...cluster('one two', part(10, ','), 0, 1500),
      ...cluster('three four', part(10), 1600, 3000),
      ...cluster('five six', part(10, '.'), 3100, 4500),
    ];
    const cues = run(tokens);
    expect(cues.map((c) => words(c.targetText).length)).toEqual([10, 20]);
    expect(cues.map((c) => c.timing)).toEqual(['measured', 'measured']);
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 1500],
      [1600, 4500],
    ]);
  });

  it('một cụm tự vượt giới hạn: chia phần dịch, mốc ước lượng hút về ranh giới từ gốc, trong khoảng của cụm', () => {
    const target = Array.from({ length: 60 }, (_, i) => (i === 29 ? 'giữa,' : `từ${i}`)).join(' ');
    const source = Array.from({ length: 30 }, (_, i) => `s${i}`).join(' ');
    const tokens = cluster(source, target, 10_000, 16_000);
    const cues = run(tokens);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues.every((c) => c.timing === 'estimated')).toBe(true);
    expect(cues[0]!.startMs).toBe(10_000);
    expect(cues.at(-1)!.endMs).toBeGreaterThanOrEqual(16_000);
    const boundaries = new Set(Array.from({ length: 30 }, (_, i) => 10_000 + i * 200));
    for (const c of cues.slice(1)) expect(boundaries.has(c.startMs)).toBe(true);
    for (const c of cues) {
      expect(words(c.targetText).length).toBeLessThanOrEqual(24);
      expect(words(c.targetText).length).toBeGreaterThanOrEqual(5);
      expect(c.sourceText.length).toBeGreaterThan(0);
    }
    expect(cues.map((c) => c.targetText.replace('\n', ' ')).some((t) => t.endsWith('giữa,'))).toBe(true);
  });

  it('cue hơn 12 từ được ngắt thành hai dòng cân nhau, ưu tiên sau dấu câu', () => {
    const [cue] = run(cluster('a b c', 'Một hai ba bốn năm sáu bảy tám, chín mười mười một mười hai mười ba.', 0, 4000));
    expect(cue!.targetText).toBe('Một hai ba bốn năm sáu bảy tám,\nchín mười mười một mười hai mười ba.');
    const [flat] = run(cluster('a b c', Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '), 0, 4000));
    expect(flat!.targetText.split('\n').map((l) => words(l).length)).toEqual([10, 10]);
    const [short] = run(cluster('a', Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '), 0, 4000));
    expect(short!.targetText).not.toContain('\n');
  });

  it('thời lượng tối thiểu 700 ms: kéo vào khoảng trống, không chồng cue sau, không quá thời lượng video', () => {
    const cues = run([...cluster('hi.', 'chào.', 1000, 1200), ...cluster('yo.', 'ừ.', 1500, 1600), ...cluster('end.', 'hết.', 9800, 9900)], 10_000);
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [1000, 1500],
      [1500, 2200],
      [9800, 10_000],
    ]);
  });

  it('người nói chen nhau: cue trước bị cắt tại đầu cue sau; còn dưới 100 ms thì gộp vào cue sau', () => {
    const cues = run([...cluster('first.', 'đầu tiên.', 0, 3000, { speaker: '1' }), ...cluster('second.', 'thứ hai.', 2000, 4000, { speaker: '2' })]);
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 2000],
      [2000, 4000],
    ]);
    const merged = run([...cluster('a.', 'a.', 1000, 3000, { speaker: '1' }), ...cluster('b.', 'b.', 1040, 4000, { speaker: '2' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startMs: 1000, endMs: 4000, targetText: 'a. b.', sourceText: 'a. b.' });
  });

  it('đoạn không có bản dịch: giữ câu gốc, cờ untranslated, không trộn vào câu đã dịch', () => {
    // chỉ nhận ra được khi lời gốc kế tiếp thuộc cụm khác (đổi người nói): hai dãy lời gốc liền nhau là một cụm
    const tokens = [...cluster('good', 'tốt', 0, 800, { speaker: '1' }), ...cluster('lost', '', 900, 1500, { speaker: '2' }), ...cluster('again', 'lại', 1600, 2400, { speaker: '1' })];
    const cues = run(tokens);
    expect(cues.map((c) => [c.sourceText, c.targetText, c.flags.untranslated ?? false])).toEqual([
      ['good', 'tốt', false],
      ['lost', '', true],
      ['again', 'lại', false],
    ]);
  });

  it('chuỗi không có khoảng trắng: giới hạn tính theo ký tự (84 mỗi cue, 42 mỗi dòng)', () => {
    const chars = 'これは長い日本語の文章です'.repeat(14); // 182 ký tự, không khoảng trắng
    const tokens = [...chars].map((c, i) => tok(c, i * 100, i * 100 + 100, { translation_status: 'original', language: 'ja' }));
    const cues = run(tokens);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    for (const c of cues) {
      expect([...c.sourceText.replace('\n', '')].length).toBeLessThanOrEqual(84);
      expect(c.flags.untranslated).toBe(true);
    }
  });

  it('đọc nhanh hơn 21 ký tự mỗi giây được đánh dấu', () => {
    const [fast, slow] = run([...cluster('a.', 'đây là một câu rất dài cần đọc thật nhanh.', 0, 1000), ...cluster('b.', 'chậm.', 5000, 6000)]);
    expect(fast!.flags.fast).toBe(true);
    expect(slow!.flags.fast).toBeUndefined();
  });

  it('không có lời nói: không có cue', () => {
    expect(segmentCues([], { durationMs: 1000 })).toEqual([]);
    expect(segmentCues([tok(' (music)', 0, 900, { is_audio_event: true })], { durationMs: 1000 })).toEqual([]);
  });

  it('mốc ngoài thời lượng video được kẹp vào trong', () => {
    const cues = run([...cluster('a.', 'a.', 9950, 10_400), ...cluster('b.', 'b.', 10_500, 11_000)], 10_000);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ startMs: 9900, endMs: 10_000 });
  });

  it('dữ liệu ngẫu nhiên giữ mọi bất biến', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
    for (let round = 0; round < 40; round++) {
      const tokens: SonioxToken[] = [];
      let t = rnd(500);
      const clusters = 1 + rnd(25);
      for (let i = 0; i < clusters; i++) {
        const dur = 100 + rnd(rnd(5) === 0 ? 20_000 : 2500);
        const sw = 1 + rnd(12);
        const kind = rnd(10);
        const tw = kind === 0 ? 0 : 1 + rnd(rnd(6) === 0 ? 70 : 14);
        const src = Array.from({ length: sw }, (_, k) => `s${i}x${k}${rnd(8) === 0 ? '.' : ''}`).join(' ');
        const dst = kind === 1 ? null : Array.from({ length: tw }, (_, k) => `t${i}y${k}${rnd(9) === 0 ? ',' : rnd(9) === 0 ? '.' : ''}`).join(' ');
        tokens.push(...cluster(src, dst, t, t + dur, { speaker: String(1 + rnd(2)) }));
        t += Math.max(0, dur - (rnd(6) === 0 ? rnd(1500) : 0)) + rnd(700);
      }
      run(tokens, t + 2000);
    }
  });
});
