'use client';

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { apiPatch } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

export type ThemeMode = 'light' | 'dark' | 'system';

const modesOf = (t: Dict): Array<{ value: ThemeMode; label: string; icon: React.ComponentType<{ className?: string }> }> => [
  { value: 'light', label: t.theme.light, icon: Sun },
  { value: 'dark', label: t.theme.dark, icon: Moon },
  { value: 'system', label: t.theme.system, icon: Monitor },
];

/**
 * Nút đổi giao diện Sáng / Tối / Theo hệ thống (spec 003, FR-016). Đổi có hiệu lực ngay, không tải lại; lựa chọn được
 * `next-themes` lưu theo trình duyệt và, khi đã đăng nhập, ghi thêm vào tài khoản (thất bại không ảnh hưởng giao diện).
 */
export function ThemeToggle() {
  const t = useT();
  const MODES = modesOf(t);
  const { theme = 'system', setTheme } = useTheme();
  // next-themes chỉ biết theme thật sau khi gắn vào trình duyệt: tránh lệch dấu tích giữa SSR và client
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const current = (mounted ? theme : 'system') as ThemeMode;

  function choose(mode: ThemeMode) {
    setTheme(mode);
    // Chưa đăng nhập (trang đăng nhập/đăng ký) thì 401: bỏ qua, lựa chọn vẫn nằm ở trình duyệt
    void apiPatch('/api/me', { theme: mode }).catch(() => undefined);
  }

  const Icon = MODES.find((m) => m.value === current)?.icon ?? Monitor;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`${t.theme.label}: ${MODES.find((m) => m.value === current)?.label ?? ''}`}>
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {MODES.map((m) => (
          <DropdownMenuItem key={m.value} onSelect={() => choose(m.value)} aria-checked={current === m.value} role="menuitemradio">
            <m.icon className="size-4" />
            <span className="flex-1">{m.label}</span>
            {current === m.value ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Đồng bộ theme của tài khoản vào trình duyệt khi đăng nhập (spec 003, FR-016/FR-017): tài khoản là nguồn đúng khi đã
 * đăng nhập, nên giá trị đã lưu trong tài khoản ghi đè giá trị cục bộ nếu khác. Chạy một lần mỗi lần tải trang.
 */
export function ThemeSync({ theme }: { theme: ThemeMode | undefined }) {
  const { theme: local, setTheme } = useTheme();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !theme || local === undefined) return;
    done.current = true;
    if (local !== theme) setTheme(theme);
  }, [theme, local, setTheme]);
  return null;
}
