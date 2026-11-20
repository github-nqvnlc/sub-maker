'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api, apiDelete, apiPatch } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  status: 'active' | 'banned' | 'deleting';
  canUseCustomAi: boolean;
  createdAt: string;
  lastActiveAt: string | null;
};
type ListResult = { items: AdminUser[]; total: number; page: number; pageSize: number };

const PAGE_SIZE = 20;
const ALL = 'all';

const statusLabelOf = (t: Dict): Record<AdminUser['status'], string> => ({
  active: t.adminUsers.statusActive,
  banned: t.adminUsers.statusBanned,
  deleting: t.adminUsers.statusDeleting,
});

export function UsersTable() {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (debouncedQ.trim()) params.set('q', debouncedQ.trim());
  if (status !== ALL) params.set('status', status);

  const list = useQuery({
    queryKey: ['admin-users', params.toString()],
    queryFn: () => api<ListResult>(`/api/admin/users?${params}`),
    refetchInterval: (query) => (query.state.data?.items.some((u) => u.status === 'deleting') ? 3000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  const setUserStatus = useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'banned' }) => apiPatch(`/api/admin/users/${v.id}`, { status: v.status }),
    onSuccess: () => {
      toast.success(t.adminUsers.done);
      void refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  const columns: Column<AdminUser>[] = [
    {
      key: 'user',
      header: t.adminUsers.colUser,
      cell: (u) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{u.displayName}</div>
          <div className="truncate text-xs text-muted-foreground">{u.email}</div>
        </div>
      ),
    },
    {
      key: 'role',
      header: t.adminUsers.colRole,
      cell: (u) => <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role === 'admin' ? t.adminUsers.roleAdmin : t.adminUsers.roleUser}</Badge>,
    },
    {
      key: 'status',
      header: t.adminUsers.colStatus,
      cell: (u) => <Badge variant={u.status === 'active' ? 'outline' : 'destructive'}>{statusLabelOf(t)[u.status]}</Badge>,
    },
    { key: 'created', header: t.adminUsers.colCreated, cell: (u) => <span className="whitespace-nowrap text-sm">{u.createdAt ? fx.dateTime(u.createdAt) : t.adminUsers.never}</span>, className: 'hidden md:table-cell' },
    { key: 'active', header: t.adminUsers.colActive, cell: (u) => <span className="whitespace-nowrap text-sm">{u.lastActiveAt ? fx.dateTime(u.lastActiveAt) : t.adminUsers.never}</span>, className: 'hidden lg:table-cell' },
    {
      key: 'actions',
      header: t.adminUsers.colActions,
      cell: (u) =>
        u.role === 'admin' ? (
          <span className="text-xs text-muted-foreground">{t.adminUsers.protectedAdmin}</span>
        ) : u.status === 'deleting' ? null : (
          <div className="flex flex-wrap gap-1">
            {u.status === 'banned' ? (
              <Button size="sm" variant="outline" onClick={() => setUserStatus.mutate({ id: u.id, status: 'active' })}>
                {t.adminUsers.unban}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setBanTarget(u)}>
                {t.adminUsers.ban}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setResetTarget(u)}>
              {t.adminUsers.resetPassword}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(u)}>
              {t.adminUsers.deleteUser}
            </Button>
          </div>
        ),
    },
  ];

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t.adminUsers.title}</h1>
        <p className="text-sm text-muted-foreground">{t.adminUsers.description}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.adminUsers.searchPlaceholder}
          aria-label={t.common.search}
          className="sm:max-w-sm"
        />
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="sm:w-48" aria-label={t.adminUsers.colStatus}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.adminUsers.allStatuses}</SelectItem>
            <SelectItem value="active">{t.adminUsers.statusActive}</SelectItem>
            <SelectItem value="banned">{t.adminUsers.statusBanned}</SelectItem>
            <SelectItem value="deleting">{t.adminUsers.statusDeleting}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title={debouncedQ || status !== ALL ? t.common.noResults : t.adminUsers.empty} />
      ) : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowId={(u) => u.id} />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {page}/{totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t.common.back}
              </Button>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                {t.common.next}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!banTarget}
        onOpenChange={(o) => !o && setBanTarget(null)}
        title={t.adminUsers.banTitle}
        description={
          <>
            <p className="font-medium text-foreground">{banTarget?.email}</p>
            <p>{t.adminUsers.banDesc}</p>
          </>
        }
        confirmLabel={t.adminUsers.ban}
        onConfirm={async () => {
          if (banTarget) await setUserStatus.mutateAsync({ id: banTarget.id, status: 'banned' });
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t.adminUsers.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{deleteTarget?.email}</p>
            <p>{t.adminUsers.deleteDesc}</p>
          </>
        }
        requireText={deleteTarget?.email}
        requireTextLabel={t.adminUsers.deleteConfirmLabel}
        confirmLabel={t.adminUsers.deleteUser}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await apiDelete(`/api/admin/users/${deleteTarget.id}?confirm=${encodeURIComponent(deleteTarget.email)}`);
            toast.success(t.adminUsers.deleteStarted);
            void refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : t.common.genericError);
          }
        }}
      />

      <ResetPasswordDialog key={resetTarget?.id ?? 'none'} target={resetTarget} onClose={() => setResetTarget(null)} />
    </div>
  );
}

function ResetPasswordDialog({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/users/${target.id}/reset-password`, { method: 'POST', json: { newPassword: password } });
      toast.success(t.adminUsers.done);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields?.newPassword ?? e.message) : t.common.genericError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.adminUsers.resetTitle}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{target?.email}</span>
            <br />
            {t.adminUsers.resetDesc}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reset-password">{t.adminUsers.newPassword}</Label>
          <Input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <p className="text-xs text-muted-foreground">{t.auth.passwordHint}</p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || password.length === 0}>
            {t.adminUsers.resetPassword}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
