import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/guards';
import { vi } from '@/lib/i18n/vi';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Đã đăng nhập thì không cần ở trang đăng nhập/đăng ký
  if (await getCurrentUser(await headers())) redirect('/projects');
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <h1 className="text-2xl font-semibold">{vi.app.name}</h1>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
