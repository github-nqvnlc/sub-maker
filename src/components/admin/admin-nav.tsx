'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';
import { cn } from '@/lib/utils';

const adminNav = (t: Dict) => [
  { href: '/admin/users', label: t.nav.adminUsers },
  { href: '/admin/ai-configs', label: t.nav.adminAiConfigs },
  { href: '/admin/custom-ai-users', label: t.nav.adminCustomAi },
  { href: '/admin/stats', label: t.nav.adminStats },
  { href: '/admin/settings', label: t.nav.adminSettings },
];

/**
 * Thanh tab khu Quản trị (spec 003, FR-029): tab của trang đang mở được làm nổi bật bằng nền, chữ đậm VÀ gạch chân
 * (không chỉ dựa vào màu) và được đánh dấu `aria-current="page"` cho công nghệ hỗ trợ. Đúng một tab được chọn.
 */
export function AdminNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav className="mb-6 flex flex-wrap gap-2 border-b pb-3" aria-label={t.nav.admin}>
      {adminNav(t).map((n) => {
        const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md border-b-2 px-3 py-1.5 text-sm transition-colors',
              active ? 'border-primary bg-primary/10 font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
