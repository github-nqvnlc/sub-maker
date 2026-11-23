import { describe, expect, it } from 'vitest';
import { chunkTokensToMd, chunkTokensToTxt } from '@/lib/parsing/stt-chunker';
import { SAMPLE_TOKENS } from '../mocks/soniox-mock';

describe('định dạng .txt/.md (spec 004, US2)', () => {
  it('.txt: nối câu tự nhiên, xuống dòng giữa các đoạn nói', () => {
    expect(chunkTokensToTxt(SAMPLE_TOKENS)).toBe('Xin chào các bạn. Hôm nay chúng ta học bài mới.\n\nVâng, cảm ơn thầy.\n');
  });

  it('.md có phân biệt người nói khi bật diarization', () => {
    const md = chunkTokensToMd(SAMPLE_TOKENS, { title: 'Phỏng vấn', diarization: true });
    expect(md).toContain('# Phỏng vấn');
    expect(md).toContain('**Người nói 1**: Xin chào các bạn. Hôm nay chúng ta học bài mới.');
    expect(md).toContain('**Người nói 2**: Vâng, cảm ơn thầy.');
  });

  it('.md theo ngôn ngữ giao diện tiếng Anh', () => {
    const md = chunkTokensToMd(SAMPLE_TOKENS, { diarization: true, speakerLabel: (n) => `Speaker ${n}` });
    expect(md).toContain('**Speaker 1**:');
    expect(md).toContain('**Speaker 2**:');
  });

  it('.md không gắn nhãn khi tắt diarization', () => {
    expect(chunkTokensToMd(SAMPLE_TOKENS, { diarization: false })).not.toContain('**');
  });
});
