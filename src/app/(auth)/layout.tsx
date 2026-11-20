import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { LocaleSwitch } from '@/components/app/locale-switch';
import { ThemeToggle } from '@/components/app/theme-toggle';
import { getCurrentUser } from '@/lib/auth/guards';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Đã đăng nhập thì không cần ở trang đăng nhập/đăng ký
  if (await getCurrentUser(await headers())) redirect('/projects');
  const t = await getT();
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <div className="absolute right-4 top-4 flex items-center gap-1">
        <LocaleSwitch />
        <ThemeToggle />
      </div>
      <h1 className="text-2xl font-semibold">{t.app.name}</h1>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
