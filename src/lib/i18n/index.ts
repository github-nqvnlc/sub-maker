import { en } from './en';
import { DEFAULT_LOCALE, isLocale, type Locale } from './locale';
import type { Dict } from './types';
import { vi } from './vi';

/**
 * Từ điển theo ngôn ngữ — CHỈ dùng phía máy chủ (nhập cả hai từ điển). Client nhận từ điển của ngôn ngữ đang dùng
 * qua `I18nProvider`, không nhập tệp này.
 */
export const DICTS: Record<Locale, Dict> = { vi, en };

/** Từ điển của ngôn ngữ; ngôn ngữ lạ → tiếng Việt (luôn đầy đủ, là dự phòng — Hiến pháp VI). */
export function getDict(locale: string | null | undefined): Dict {
  return isLocale(locale) ? DICTS[locale] : DICTS[DEFAULT_LOCALE];
}

export { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from './locale';
export type { Dict } from './types';
