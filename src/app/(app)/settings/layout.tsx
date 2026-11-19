import { headers } from 'next/headers';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/guards';
import { vi } from '@/lib/i18n/vi';

export const dynamic = 'force-dynamic';

/** Khung trang cài đặt cá nhân; mục "Cấu hình AI" chỉ hiện với User được phép. */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser(await headers());
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{vi.nav.settings}</h1>
      <nav className="flex flex-wrap gap-2 border-b pb-3" aria-label={vi.nav.settings}>
        <Link href="/settings/profile" className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
          {vi.nav.profile}
        </Link>
        {user?.canUseCustomAi ? (
          <Link href="/settings/ai" className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">
            {vi.nav.aiSettings}
          </Link>
        ) : null}
      </nav>
      {children}
    </div>
  );
}
