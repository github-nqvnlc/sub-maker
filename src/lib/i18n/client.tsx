'use client';

import { createContext, useContext, useMemo } from 'react';
import { DEFAULT_LOCALE, INTL_TAG, type Locale } from './locale';
import type { Dict } from './types';

type Ctx = { locale: Locale; dict: Dict };
const I18nContext = createContext<Ctx | null>(null);

/** Cung cấp ngôn ngữ và từ điển ĐANG DÙNG (do layout gốc chọn theo cookie) cho mọi thành phần client. */
export function I18nProvider({ locale, dict, children }: { locale: Locale; dict: Dict; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, dict }), [locale, dict]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useCtx(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useT/useLocale phải nằm trong I18nProvider');
  return c;
}

/** Từ điển của ngôn ngữ đang chọn: `const t = useT(); t.common.save`. */
export const useT = (): Dict => useCtx().dict;
export const useLocale = (): Locale => useCtx().locale;

/** Định dạng ngày giờ/số theo quy ước của ngôn ngữ đang chọn (vi-VN: 1.234,5 — en-US: 1,234.5). */
export function useFormat() {
  const locale = useLocale();
  const tag = INTL_TAG[locale] ?? INTL_TAG[DEFAULT_LOCALE];
  return useMemo(
    () => ({
      locale,
      number: (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(tag, opts),
      /** Tiền USD: ký hiệu $ và phân cách theo ngôn ngữ (vi-VN: $1.234,50 — en-US: $1,234.50). */
      usd: (n: number) => `$${n.toLocaleString(tag, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`,
      dateTime: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(tag) : ''),
      date: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(tag) : ''),
      time: (iso: string) => new Date(iso).toLocaleTimeString(tag, { hour12: false }),
    }),
    [locale, tag],
  );
}
