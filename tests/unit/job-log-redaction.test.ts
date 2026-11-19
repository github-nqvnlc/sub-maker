import { describe, expect, it } from 'vitest';
import { redactDeep, redactSecrets } from '@/lib/security/redact';

describe('redactSecrets', () => {
  it('che khóa đã biết dù không khớp mẫu nào', () => {
    expect(redactSecrets('Gọi thất bại với khóa abc-123-xyz-789', ['abc-123-xyz-789'])).not.toContain('abc-123-xyz-789');
  });

  it('che Bearer token', () => {
    const out = redactSecrets('Authorization: Bearer eyJhbGciOi.payload.sig');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('Bearer');
  });

  it('che tham số ?key= trên URL (đường Gemini-compatible)', () => {
    const out = redactSecrets('GET https://api.shopaikey.com/v1beta/models/x:generateContent?key=SUPERSECRET123&alt=json');
    expect(out).not.toContain('SUPERSECRET123');
    expect(out).toContain('alt=json');
  });

  it('che khóa dạng sk-...', () => {
    expect(redactSecrets('lỗi 401 với sk-AbCdEfGhIjKlMnOp')).not.toContain('AbCdEfGhIjKlMnOp');
  });

  it('che header api_key của FPT Speech', () => {
    expect(redactSecrets('headers: {"api_key": "fptSecretKey123456"}')).not.toContain('fptSecretKey123456');
    expect(redactSecrets('api_key: fptSecretKey123456')).not.toContain('fptSecretKey123456');
  });

  it('giữ nguyên văn bản không nhạy cảm (kể cả tiếng Việt)', () => {
    const msg = 'Đã gửi đoạn 3/12 (412 ký tự) tới nhà cung cấp';
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe('redactDeep', () => {
  it('che đệ quy trong đối tượng/mảng và theo tên khóa nhạy cảm', () => {
    const out = redactDeep(
      { idx: 3, headers: { Authorization: 'Bearer abcdef123456', 'x-trace': 'ok' }, api_key: 'zzz', list: ['?key=SECRET99999'] },
      ['SECRET99999'],
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain('SECRET99999');
    expect(text).not.toContain('"zzz"');
    expect(out.idx).toBe(3);
    expect((out.headers as Record<string, string>)['x-trace']).toBe('ok');
  });
});
