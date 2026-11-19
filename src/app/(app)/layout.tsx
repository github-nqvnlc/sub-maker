import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ActiveJobs } from '@/components/app/active-jobs';
import { AppShell } from '@/components/app/app-shell';
import { getCurrentUser } from '@/lib/auth/guards';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser(await headers());
  if (!user) redirect('/login');
  return (
    <AppShell
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        hasAvatar: !!user.avatarKey,
      }}
      extraHeader={<ActiveJobs />}
    >
      {children}
    </AppShell>
  );
}
