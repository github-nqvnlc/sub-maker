import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DICTS, getDict } from '@/lib/i18n';
import { fmt } from '@/lib/i18n/fmt';
import { renderJobLog } from '@/lib/i18n/job-log';
import { DEFAULT_LOCALE, INTL_TAG, LOCALES, localeFromCookieHeader } from '@/lib/i18n/locale';
import { translateFields, translateMessage } from '@/lib/i18n/server-messages';
import { PROVIDER_ERROR_MESSAGE } from '@/lib/providers/errors';
import { vi } from '@/lib/i18n/vi';

/** Làm phẳng từ điển thành cặp (đường dẫn khóa, chuỗi). */
function leaves(obj: unknown, prefix = ''): Array<[string, string]> {
  if (typeof obj === 'string') return [[prefix, obj]];
  if (obj && typeof obj === 'object') return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  return [];
}
const holders = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('từ điển vi/en (spec 003, FR-023)', () => {
  const viMap = new Map(leaves(vi));

  for (const locale of LOCALES) {
    it(`${locale}: đủ khóa so với tiếng Việt, không chuỗi rỗng, cùng giữ chỗ {…}`, () => {
      const m = new Map(leaves(DICTS[locale]));
      expect([...viMap.keys()].filter((k) => !m.has(k))).toEqual([]); // thiếu khóa
      expect([...m.keys()].filter((k) => !viMap.has(k))).toEqual([]); // thừa khóa
      for (const [k, v] of m) {
        expect(v.trim(), `${locale}.${k} rỗng`).not.toBe('');
        expect(holders(v), `giữ chỗ của ${locale}.${k}`).toEqual(holders(viMap.get(k)!));
      }
    });
  }

  it('English thật sự đã dịch: phần lớn chuỗi khác tiếng Việt (trừ tên riêng/chuỗi trùng hợp lệ)', () => {
    const en = new Map(leaves(DICTS.en));
    const same = [...viMap].filter(([k, v]) => en.get(k) === v).map(([k]) => k);
    // cho phép tên riêng và nhãn giống nhau (Sub Maker, Email, Project…); không được quá 10% giống hệt
    expect(same.length / viMap.size).toBeLessThan(0.1);
  });

  it('ngôn ngữ lạ hoặc rỗng rơi về tiếng Việt (dự phòng luôn đầy đủ — Hiến pháp VI)', () => {
    expect(getDict('xx')).toBe(DICTS.vi);
    expect(getDict(undefined)).toBe(DICTS.vi);
    expect(getDict('en')).toBe(DICTS.en);
    expect(DEFAULT_LOCALE).toBe('vi');
  });
});

describe('fmt và định dạng theo ngôn ngữ', () => {
  it('fmt thay giữ chỗ, giữ nguyên giữ chỗ thiếu giá trị', () => {
    expect(fmt('{n} đoạn', { n: 3 })).toBe('3 đoạn');
    expect(fmt('Phần {a}/{b}', { a: 1 })).toBe('Phần 1/{b}');
  });

  it('số/ngày theo quy ước của ngôn ngữ: vi-VN 1.234,5 — en-US 1,234.5', () => {
    expect((1234.5).toLocaleString(INTL_TAG.vi)).toBe('1.234,5');
    expect((1234.5).toLocaleString(INTL_TAG.en)).toBe('1,234.5');
    const d = new Date(Date.UTC(2026, 10, 20, 9, 5, 7));
    expect(d.toLocaleDateString(INTL_TAG.vi, { timeZone: 'UTC' })).toBe('20/11/2026');
    expect(d.toLocaleDateString(INTL_TAG.en, { timeZone: 'UTC' })).toBe('11/20/2026');
  });

  it('localeFromCookieHeader đọc cookie `locale`, giá trị lạ/thiếu → tiếng Việt', () => {
    expect(localeFromCookieHeader('a=1; locale=en; b=2')).toBe('en');
    expect(localeFromCookieHeader('locale=vi')).toBe('vi');
    expect(localeFromCookieHeader('locale=fr')).toBe('vi');
    expect(localeFromCookieHeader('theme=dark')).toBe('vi');
    expect(localeFromCookieHeader(null)).toBe('vi');
  });
});

describe('dịch thông báo máy chủ (FR-022)', () => {
  it('tiếng Việt giữ nguyên; câu của vi.errors/vi.validation dịch theo khóa', () => {
    expect(translateMessage('vi', vi.errors.NOT_FOUND)).toBe(vi.errors.NOT_FOUND);
    expect(translateMessage('en', vi.errors.NOT_FOUND)).toBe(DICTS.en.errors.NOT_FOUND);
    expect(translateMessage('en', vi.validation.passwordMin)).toBe(DICTS.en.validation.passwordMin);
  });

  it('câu viết trực tiếp và mẫu có tham số', () => {
    expect(translateMessage('en', 'Không có thay đổi nào')).toBe('There are no changes');
    expect(translateMessage('en', 'Khoảng thời gian tối đa 366 ngày')).toBe('The date range can be at most 366 days');
    expect(translateMessage('en', 'File đang được dùng bởi 3 tiến trình/voice. Hãy xóa các tiến trình đó trước.')).toBe('The file is used by 3 jobs/voices. Delete those jobs first.');
    expect(translateMessage('en', 'Tốc độ phải từ 0.25 đến 4')).toBe('Speed must be between 0.25 and 4');
  });

  it('câu lạ giữ nguyên (không mất thông tin); translateFields dịch từng trường', () => {
    expect(translateMessage('en', 'Một câu chưa có bản dịch')).toBe('Một câu chưa có bản dịch');
    expect(translateFields('en', { file: 'Tệp rỗng.', other: 'xyz' })).toEqual({ file: 'The file is empty.', other: 'xyz' });
    expect(translateFields('vi', { file: 'Tệp rỗng.' })).toEqual({ file: 'Tệp rỗng.' });
  });

  it('mọi thông báo lỗi của nhà cung cấp đều có bản dịch', () => {
    for (const [kind, msg] of Object.entries(PROVIDER_ERROR_MESSAGE)) {
      expect(translateMessage('en', msg), `PROVIDER_ERROR_MESSAGE.${kind}`).not.toBe(msg);
    }
  });

  /** Quét mã nguồn: câu tiếng Việt trong lời gọi tạo lỗi phải có bản dịch (không để lọt chữ Việt ra giao diện English). */
  it('mọi câu tiếng Việt trong lời gọi tạo lỗi ở src/lib và src/app/api đều dịch được', () => {
    const VI = /[ăâđêôơưĂÂĐÊÔƠƯàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;
    const CALL = /(new HttpError\(|conflict\(|validation\(|notFound\(|new ScriptError\()/;
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(ent.name) && !/i18n[\\/](vi|en|server-messages)\.ts$/.test(full)) {
          fs.readFileSync(full, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              if (!CALL.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
              for (const m of line.matchAll(/(['`])((?:\\.|(?!\1).)*)\1/g)) {
                const lit = m[2]!;
                if (!VI.test(lit)) continue;
                const sample = lit.replace(/\$\{[^}]+\}/g, '7');
                if (translateMessage('en', sample) === sample) missing.push(`${full.split(path.sep).join('/')}:${i + 1} — ${sample.slice(0, 90)}`);
              }
            });
        }
      }
    };
    walk('src/lib');
    walk('src/app/api');
    expect(missing, `Thiếu bản dịch ở src/lib/i18n/server-messages.ts:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('renderJobLog (nhật ký tiến trình theo ngôn ngữ)', () => {
  const en = DICTS.en;
  it('tiếng Việt hiện đúng câu đã lưu', () => {
    expect(renderJobLog(DICTS.vi, 'vi', { code: 'JOB_STARTED', message: 'Bắt đầu tạo voice' })).toBe('Bắt đầu tạo voice');
  });
  it('English dựng từ mẫu + meta (chỉ số đoạn +1, giây, khoảng đoạn)', () => {
    expect(renderJobLog(en, 'en', { code: 'JOB_STARTED', message: 'Bắt đầu tạo voice' })).toBe('Started creating the voice');
    expect(renderJobLog(en, 'en', { code: 'SEGMENT_DONE', message: 'x', meta: { idx: 2, chars: 40, durationMs: 3450 } })).toBe('Segment 3: done (3.5 seconds)');
    expect(renderJobLog(en, 'en', { code: 'PART_STARTED', message: 'x', meta: { part: 2, parts: 5, from: 10, to: 19 } })).toBe('Part 2/5: segments 11–20');
    expect(renderJobLog(en, 'en', { code: 'UNITS_FAILED', message: 'x', meta: { blocked: [1, 4, 7] } })).toBe('The provider rejected the content of 3 segments. They are left silent and the voice is still created.');
  });
  it('thiếu mẫu hoặc thiếu meta → rơi về câu đã lưu', () => {
    expect(renderJobLog(en, 'en', { code: 'JOB_FAILED', message: 'Lỗi gì đó' })).toBe('Lỗi gì đó');
    expect(renderJobLog(en, 'en', { code: 'SEGMENT_DONE', message: 'Đoạn 1: xong', meta: {} })).toBe('Đoạn 1: xong');
  });
});
