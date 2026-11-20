import { cookies } from 'next/headers';
import { getDict } from './index';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './locale';
import type { Dict } from './types';

/** Ngôn ngữ của yêu cầu hiện tại (Server Component / layout), đọc từ cookie `locale`; mặc định tiếng Việt. */
export async function getLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** Từ điển của yêu cầu hiện tại cho Server Component. */
export async function getT(): Promise<Dict> {
  return getDict(await getLocale());
}
