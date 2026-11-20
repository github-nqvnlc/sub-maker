/**
 * Ngôn ngữ giao diện (spec 003, US4). Tệp này KHÔNG import từ điển để client/server dùng chung mà không kéo
 * mọi ngôn ngữ vào bundle. Thêm ngôn ngữ thứ ba = thêm mã vào LOCALES + một tệp từ điển + một mục trong `index.ts`.
 */
export const LOCALES = ['vi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'vi';
/** Cookie lưu ngôn ngữ (đọc ở máy chủ khi render). Không chứa dữ liệu nhạy cảm nên không cần HttpOnly. */
export const LOCALE_COOKIE = 'locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

/** Thẻ BCP 47 dùng cho Intl (ngày giờ, số). */
export const INTL_TAG: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' };

/** Đọc ngôn ngữ từ chuỗi Cookie của yêu cầu HTTP; không hợp lệ/không có → mặc định (tiếng Việt). */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === LOCALE_COOKIE) {
      const v = decodeURIComponent(rest.join('='));
      if (isLocale(v)) return v;
    }
  }
  return DEFAULT_LOCALE;
}
