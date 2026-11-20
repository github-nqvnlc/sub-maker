import { headers } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/guards';
import { getT } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

/** Khung trang cài đặt cá nhân; mục "Cấu hình AI" chỉ hiện với User được phép. */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser(await headers());
  const t = await getT();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t.nav.settings}</h1>
      <nav className="flex flex-wrap gap-2 border-b pb-3" aria-label={t.nav.settings}>
        <Link href="/settings/profile" className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
          {t.nav.profile}
        </Link>
        {user?.canUseCustomAi ? (
          <Link href="/settings/ai" className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
            {t.nav.aiSettings}
          </Link>
        ) : null}
      </nav>
      {children}
    </div>
  );
}
