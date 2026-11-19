import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { AppShell } from '@/components/app/app-shell';
import { getCurrentUser } from '@/lib/auth/guards';
import { vi } from '@/lib/i18n/vi';

export const dynamic = 'force-dynamic';

const ADMIN_NAV = [
  { href: '/admin/users', label: vi.nav.adminUsers },
  { href: '/admin/ai-configs', label: vi.nav.adminAiConfigs },
  { href: '/admin/custom-ai-users', label: vi.nav.adminCustomAi },
  { href: '/admin/stats', label: vi.nav.adminStats },
  { href: '/admin/settings', label: vi.nav.adminSettings },
];

/** Khu vực quản trị: User thường nhận 404 (không lộ sự tồn tại, Nguyên tắc I). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser(await headers());
  if (!user) redirect('/login');
  if (user.role !== 'admin') notFound();
  return (
    <AppShell user={{ id: user.id, name: user.name, email: user.email, role: user.role, hasAvatar: !!user.avatarKey }}>
      <nav className="mb-6 flex flex-wrap gap-2 border-b pb-3" aria-label={vi.nav.admin}>
        {ADMIN_NAV.map((n) => (
          <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
            {n.label}
          </Link>
        ))}
      </nav>
      {children}
    </AppShell>
  );
}
