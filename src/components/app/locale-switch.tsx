'use client';

import { Check, Languages } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { apiPatch } from '@/lib/api-client';
import { useLocale, useT } from '@/lib/i18n/client';
import { LOCALES, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from '@/lib/i18n/locale';

/** Ghi cookie ngôn ngữ (máy chủ đọc để render đúng ngôn ngữ ngay lần tải sau). */
export function setLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Nút đổi ngôn ngữ giao diện Tiếng Việt / English (spec 003, FR-020/FR-021). Đổi ngay không tải lại: ghi cookie, `router.refresh()`
 * để máy chủ dựng lại với từ điển mới (trạng thái nhập liệu ở client được giữ), và khi đã đăng nhập ghi thêm vào tài khoản.
 */
export function LocaleSwitch() {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();

  function choose(next: Locale) {
    if (next === locale) return;
    setLocaleCookie(next);
    // Chưa đăng nhập (trang đăng nhập/đăng ký) thì 401: bỏ qua, lựa chọn vẫn nằm ở cookie
    void apiPatch('/api/me', { locale: next }).catch(() => undefined);
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`${t.locale.label}: ${t.locale[locale]}`}>
          <Languages className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((l) => (
          <DropdownMenuItem key={l} role="menuitemradio" aria-checked={l === locale} onSelect={() => choose(l)}>
            <span className="flex-1">{t.locale[l]}</span>
            {l === locale ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Đồng bộ ngôn ngữ của tài khoản khi đã đăng nhập (spec 003, FR-021): tài khoản là nguồn đúng, nên nếu khác cookie của trình duyệt
 * (ví dụ đăng nhập trên thiết bị khác) thì ghi cookie và dựng lại một lần mỗi lần tải trang.
 */
export function LocaleSync({ locale }: { locale: Locale | undefined }) {
  const current = useLocale();
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !locale) return;
    done.current = true;
    if (locale !== current) {
      setLocaleCookie(locale);
      router.refresh();
    }
  }, [locale, current, router]);
  return null;
}
