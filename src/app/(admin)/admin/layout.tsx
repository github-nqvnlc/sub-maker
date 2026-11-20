import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { AdminNav } from '@/components/admin/admin-nav';
import { AppShell } from '@/components/app/app-shell';
import { getCurrentUser } from '@/lib/auth/guards';

export const dynamic = 'force-dynamic';

/** Khu vực quản trị: User thường nhận 404 (không lộ sự tồn tại, Nguyên tắc I). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser(await headers());
  if (!user) redirect('/login');
  if (user.role !== 'admin') notFound();
  return (
    <AppShell user={{ id: user.id, name: user.name, email: user.email, role: user.role, hasAvatar: !!user.avatarKey, theme: user.theme, locale: user.locale }}>
      <AdminNav />
      {children}
    </AppShell>
  );
}
