'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { BarChart3, FolderOpen, Menu, Settings, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { UserMenu, type ShellUser } from '@/components/app/user-menu';
import { vi } from '@/lib/i18n/vi';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: '/projects', label: vi.nav.projects, icon: FolderOpen },
  { href: '/dashboard', label: vi.nav.dashboard, icon: BarChart3 },
  { href: '/settings/profile', label: vi.nav.settings, icon: Settings },
  { href: '/admin/users', label: vi.nav.admin, icon: Shield, adminOnly: true },
];

function NavLinks({ user, onNavigate }: { user: ShellUser; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1" aria-label={vi.nav.mainNav}>
      {NAV.filter((n) => !n.adminOnly || user.role === 'admin').map((n) => {
        const section = n.href.split('/')[1];
        const active = pathname === n.href || pathname.startsWith(`/${section}`);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
              active && 'bg-accent font-medium text-accent-foreground',
            )}
          >
            <n.icon className="size-4" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Khung ứng dụng: thanh bên cố định trên màn hình rộng, menu trượt trên điện thoại/tablet (FR-031). */
export function AppShell({ user, children, extraHeader }: { user: ShellUser; children: React.ReactNode; extraHeader?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r bg-sidebar p-4 md:block">
        <Link href="/projects" className="mb-6 block px-3 text-lg font-semibold">
          {vi.app.name}
        </Link>
        <NavLinks user={user} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label={vi.nav.openMenu}>
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-4">
              <SheetHeader className="p-0 pb-4">
                <SheetTitle>{vi.app.name}</SheetTitle>
              </SheetHeader>
              <NavLinks user={user} onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="font-semibold md:hidden">{vi.app.name}</span>
          <div className="ml-auto flex items-center gap-2">
            {extraHeader}
            <UserMenu user={user} />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
