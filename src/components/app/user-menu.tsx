'use client';

import Link from 'next/link';
import { LogOut, User as UserIcon } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/lib/i18n/client';

export type ShellUser = {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  hasAvatar: boolean;
  avatarVersion?: number;
  /** Tùy chọn giao diện đã lưu trong tài khoản (spec 003). */
  theme?: 'light' | 'dark' | 'system';
  locale?: 'vi' | 'en';
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const last = parts.at(-1) ?? '?';
  return ([...last][0] ?? '?').toUpperCase();
}

export function UserMenu({ user }: { user: ShellUser }) {
  const t = useT();
  async function logout() {
    await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    // Tải lại toàn trang có chủ đích: xóa mọi trạng thái/cache phía client của phiên đã đăng xuất.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = '/login';
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="lg" className="gap-2 px-2 hover:bg-transparent dark:hover:bg-transparent">
          <Avatar className="size-8">
            {user.hasAvatar ? <AvatarImage src={`/api/me/avatar?v=${user.avatarVersion ?? 0}`} alt="" /> : null}
            <AvatarFallback>{initials(user.name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-32 truncate text-sm sm:inline">{user.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/profile">
            <UserIcon className="size-4" />
            {t.nav.profile}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut className="size-4" />
          {t.nav.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
