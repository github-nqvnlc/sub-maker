'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingList } from '@/components/shared/states';
import { api } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';

export type PickedUser = { id: string; email: string; displayName: string };
type U = PickedUser & { role: 'admin' | 'user'; status: string };

/**
 * Chọn nhiều User cho chế độ "Chỉ định User" (spec 004, US5). Tìm theo email hoặc tên — máy chủ so khớp không dấu
 * (immutable_unaccent, Hiến pháp VI) — cùng cách tìm ứng viên của danh sách "dùng AI riêng".
 */
export function UserAssignmentPicker({ value, onChange }: { value: PickedUser[]; onChange: (users: PickedUser[]) => void }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const candidates = useQuery({
    queryKey: ['assign-candidates', debounced],
    enabled: debounced.length >= 2,
    queryFn: async () => {
      const r = await api<{ items: U[] }>(`/api/admin/users?q=${encodeURIComponent(debounced)}&status=active&pageSize=10`);
      return r.items.filter((u) => u.role === 'user');
    },
  });
  const picked = new Set(value.map((u) => u.id));
  const list = (candidates.data ?? []).filter((u) => !picked.has(u.id));

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t.providersAdmin.pickUsers}>
          {value.map((u) => (
            <li key={u.id}>
              <Badge variant="secondary" className="gap-1 pr-1">
                <span className="max-w-48 truncate" title={u.email}>
                  {u.displayName || u.email}
                </span>
                <button
                  type="button"
                  className="cursor-pointer rounded-sm p-0.5 hover:bg-muted-foreground/20"
                  aria-label={`${t.aiConfig.removeUser}: ${u.email}`}
                  onClick={() => onChange(value.filter((x) => x.id !== u.id))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.providersAdmin.searchUsers} aria-label={t.providersAdmin.pickUsers} />
      {debounced.length >= 2 ? (
        candidates.isPending ? (
          <LoadingList rows={2} />
        ) : list.length > 0 ? (
          <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
            {list.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 p-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{u.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, { id: u.id, email: u.email, displayName: u.displayName }])}>
                  {t.aiConfig.addUser}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t.providersAdmin.noUsers}</p>
        )
      ) : null}
    </div>
  );
}
