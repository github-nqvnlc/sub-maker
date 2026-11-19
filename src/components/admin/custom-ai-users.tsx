'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { api, apiDelete, apiPost } from '@/lib/api-client';
import { vi } from '@/lib/i18n/vi';

type U = { id: string; email: string; displayName: string; role: 'admin' | 'user'; status: string; canUseCustomAi: boolean };

/** Quản lý "Danh sách User được dùng cấu hình AI riêng" (FR-042): thêm/gỡ, có tìm kiếm. */
export function CustomAiUsers() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [removeTarget, setRemoveTarget] = useState<U | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery({
    queryKey: ['custom-ai-users', filter],
    queryFn: () => api<U[]>(`/api/admin/custom-ai-users${filter.trim() ? `?q=${encodeURIComponent(filter.trim())}` : ''}`),
  });

  // Ứng viên để thêm: User thường đang hoạt động, chưa nằm trong danh sách
  const candidates = useQuery({
    queryKey: ['custom-ai-candidates', debounced],
    enabled: debounced.length >= 2,
    queryFn: async () => {
      const r = await api<{ items: U[] }>(`/api/admin/users?q=${encodeURIComponent(debounced)}&status=active&pageSize=10`);
      return r.items.filter((u) => u.role === 'user' && !u.canUseCustomAi);
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['custom-ai-users'] });
    void qc.invalidateQueries({ queryKey: ['custom-ai-candidates'] });
  };

  const add = useMutation({
    mutationFn: (userId: string) => apiPost('/api/admin/custom-ai-users', { userId }),
    onSuccess: () => {
      toast.success(vi.aiConfig.added);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : vi.common.genericError),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{vi.aiConfig.customUsersTitle}</h1>
        <p className="text-sm text-muted-foreground">{vi.aiConfig.customUsersDescription}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{vi.aiConfig.addUser}</CardTitle>
          <CardDescription />
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={vi.aiConfig.addPlaceholder} aria-label={vi.aiConfig.addUser} />
          {debounced.length >= 2 ? (
            candidates.isPending ? (
              <LoadingList rows={2} />
            ) : candidates.data && candidates.data.length > 0 ? (
              <ul className="divide-y rounded-md border">
                {candidates.data.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{u.displayName}</div>
                      <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                    </div>
                    <Button size="sm" disabled={add.isPending} onClick={() => add.mutate(u.id)}>
                      {vi.aiConfig.addUser}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{vi.aiConfig.noCandidates}</p>
            )
          ) : null}
        </CardContent>
      </Card>

      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={vi.common.search} aria-label={vi.common.search} className="max-w-sm" />

      {list.isPending ? (
        <LoadingList rows={3} />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState title={filter ? vi.common.noResults : vi.aiConfig.listEmpty} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.data.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{u.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">{u.email}</div>
              </div>
              <div className="flex items-center gap-2">
                {u.status !== 'active' ? <Badge variant="destructive">{u.status}</Badge> : null}
                <Button size="sm" variant="outline" onClick={() => setRemoveTarget(u)}>
                  {vi.aiConfig.removeUser}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={vi.aiConfig.removeTitle}
        description={
          <>
            <p className="font-medium text-foreground">{removeTarget?.email}</p>
            <p>{vi.aiConfig.removeDesc}</p>
          </>
        }
        confirmLabel={vi.aiConfig.removeUser}
        onConfirm={async () => {
          if (!removeTarget) return;
          await apiDelete(`/api/admin/custom-ai-users/${removeTarget.id}`);
          toast.success(vi.aiConfig.removed);
          refresh();
        }}
      />
    </div>
  );
}
