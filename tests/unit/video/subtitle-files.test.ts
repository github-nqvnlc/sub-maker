import { describe, expect, it } from 'vitest';
import { parseSrtCues } from '@/lib/parsing/srt';
import { buildSubtitleFile, subtitleFileName } from '@/lib/video/subtitle-files';
import type { Cue } from '@/lib/video/types';

/** Tệp phụ đề tải về (spec 006, T071; contracts/subtitle-pipeline.md §6; FR-039). */

const cue = (startMs: number, endMs: number, sourceText: string, targetText: string, sourceLang: string | null = 'en'): Cue => ({
  id: crypto.randomUUID(),
  startMs,
  endMs,
  timing: 'measured',
  sourceText,
  targetText,
  sourceLang,
  speaker: null,
  flags: {},
});

const cues = [cue(120, 1180, 'Hello everyone.', 'Xin chào mọi người.'), cue(1800, 3680, 'Today we learn\nsomething new.', 'Hôm nay chúng ta\nhọc điều mới.'), cue(3_605_007, 3_606_500, 'Thank you.', 'Cảm ơn.')];

describe('.srt', () => {
  it('đánh số liên tục, mốc hh:mm:ss,mmm, bản dịch là mặc định', () => {
    expect(buildSubtitleFile(cues, 'srt')).toBe(
      '1\n00:00:00,120 --> 00:00:01,180\nXin chào mọi người.\n\n2\n00:00:01,800 --> 00:00:03,680\nHôm nay chúng ta\nhọc điều mới.\n\n3\n01:00:05,007 --> 01:00:06,500\nCảm ơn.\n',
    );
  });

  it('bản gốc; song ngữ đặt câu gốc trên, câu dịch dưới', () => {
    expect(buildSubtitleFile(cues.slice(0, 1), 'srt', 'source')).toBe('1\n00:00:00,120 --> 00:00:01,180\nHello everyone.\n');
    expect(buildSubtitleFile(cues.slice(0, 1), 'srt', 'bilingual')).toBe('1\n00:00:00,120 --> 00:00:01,180\nHello everyone.\nXin chào mọi người.\n');
  });

  it('bỏ cue không có chữ và đánh số lại; đoạn chưa dịch dùng câu gốc như khung xem trước', () => {
    const list = [cue(0, 500, '', ''), cue(1000, 1500, 'Only source.', ''), cue(2000, 2500, '', 'Chỉ bản dịch.')];
    expect(buildSubtitleFile(list, 'srt')).toBe('1\n00:00:01,000 --> 00:00:01,500\nOnly source.\n\n2\n00:00:02,000 --> 00:00:02,500\nChỉ bản dịch.\n');
    expect(buildSubtitleFile(list, 'srt', 'source')).toBe('1\n00:00:01,000 --> 00:00:01,500\nOnly source.\n');
    expect(buildSubtitleFile(list, 'srt', 'bilingual')).toBe('1\n00:00:01,000 --> 00:00:01,500\nOnly source.\n\n2\n00:00:02,000 --> 00:00:02,500\nChỉ bản dịch.\n');
  });

  it('dòng trống và chuỗi --> trong chữ không làm vỡ tệp; chữ chuẩn NFC; đọc lại được', () => {
    const text = 'a --> b\n\n   \n2\n00:00:09,000 --> 00:00:10,000'.concat('\n', 'Tiếng Việt'.normalize('NFD'));
    const file = buildSubtitleFile([cue(0, 900, 'x', text), cue(1000, 2000, 'y', 'hết')], 'srt');
    expect(file).not.toContain('a -->');
    expect(file).toContain('a → b\n2\n00:00:09,000 → 00:00:10,000\nTiếng Việt'.normalize('NFC'));
    const parsed = parseSrtCues(file);
    expect(parsed.cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 900],
      [1000, 2000],
    ]);
  });

  it('không có cue nào → tệp rỗng', () => {
    expect(buildSubtitleFile([], 'srt')).toBe('');
  });
});

describe('.vtt', () => {
  it('dòng đầu WEBVTT, mốc dùng dấu chấm, thoát &, <, >', () => {
    expect(buildSubtitleFile([cue(120, 1180, 'x', 'A & B <i>đậm</i> > c')], 'vtt')).toBe('WEBVTT\n\n1\n00:00:00.120 --> 00:00:01.180\nA &amp; B &lt;i&gt;đậm&lt;/i&gt; &gt; c\n');
    expect(buildSubtitleFile([], 'vtt')).toBe('WEBVTT\n');
  });
});

describe('tên tệp', () => {
  it('tên video bỏ đuôi, thêm ngôn ngữ của nội dung', () => {
    expect(subtitleFileName('Bài giảng 1.mp4', cues, 'to_vi', 'target', 'srt')).toBe('Bài giảng 1.vi.srt');
    expect(subtitleFileName('Bài giảng 1.mp4', cues, 'to_vi', 'source', 'vtt')).toBe('Bài giảng 1.en.vtt');
    expect(subtitleFileName('a.b.mkv', cues, 'to_vi', 'bilingual', 'srt')).toBe('a.b.en-vi.srt');
    expect(subtitleFileName('phim.mov', [], 'vi_to_en', 'source', 'srt')).toBe('phim.vi.srt');
    expect(subtitleFileName('phim', [cue(0, 1000, 'x', 'y', null)], 'to_vi', 'source', 'srt')).toBe('phim.src.srt');
  });
  it('ngôn ngữ gốc là ngôn ngữ chiếm nhiều cue nhất', () => {
    const mixed = [cue(0, 100, 'a', 'b', 'ja'), cue(200, 300, 'a', 'b', 'ja'), cue(400, 500, 'a', 'b', 'en')];
    expect(subtitleFileName('v.mp4', mixed, 'to_vi', 'source', 'srt')).toBe('v.ja.srt');
  });
});
