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
import { vi } from '@/lib/i18n/vi';

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

const statusLabel: Record<AdminUser['status'], string> = {
  active: vi.adminUsers.statusActive,
  banned: vi.adminUsers.statusBanned,
  deleting: vi.adminUsers.statusDeleting,
};

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('vi-VN') : vi.adminUsers.never;
}

export function UsersTable() {
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
      toast.success(vi.adminUsers.done);
      void refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : vi.common.genericError),
  });

  const columns: Column<AdminUser>[] = [
    {
      key: 'user',
      header: vi.adminUsers.colUser,
      cell: (u) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{u.displayName}</div>
          <div className="truncate text-xs text-muted-foreground">{u.email}</div>
        </div>
      ),
    },
    {
      key: 'role',
      header: vi.adminUsers.colRole,
      cell: (u) => <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role === 'admin' ? vi.adminUsers.roleAdmin : vi.adminUsers.roleUser}</Badge>,
    },
    {
      key: 'status',
      header: vi.adminUsers.colStatus,
      cell: (u) => <Badge variant={u.status === 'active' ? 'outline' : 'destructive'}>{statusLabel[u.status]}</Badge>,
    },
    { key: 'created', header: vi.adminUsers.colCreated, cell: (u) => <span className="whitespace-nowrap text-sm">{fmt(u.createdAt)}</span>, className: 'hidden md:table-cell' },
    { key: 'active', header: vi.adminUsers.colActive, cell: (u) => <span className="whitespace-nowrap text-sm">{fmt(u.lastActiveAt)}</span>, className: 'hidden lg:table-cell' },
    {
      key: 'actions',
      header: vi.adminUsers.colActions,
      cell: (u) =>
        u.role === 'admin' ? (
          <span className="text-xs text-muted-foreground">{vi.adminUsers.protectedAdmin}</span>
        ) : u.status === 'deleting' ? null : (
          <div className="flex flex-wrap gap-1">
            {u.status === 'banned' ? (
              <Button size="sm" variant="outline" onClick={() => setUserStatus.mutate({ id: u.id, status: 'active' })}>
                {vi.adminUsers.unban}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setBanTarget(u)}>
                {vi.adminUsers.ban}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setResetTarget(u)}>
              {vi.adminUsers.resetPassword}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(u)}>
              {vi.adminUsers.deleteUser}
            </Button>
          </div>
        ),
    },
  ];

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{vi.adminUsers.title}</h1>
        <p className="text-sm text-muted-foreground">{vi.adminUsers.description}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={vi.adminUsers.searchPlaceholder}
          aria-label={vi.common.search}
          className="sm:max-w-sm"
        />
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="sm:w-48" aria-label={vi.adminUsers.colStatus}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{vi.adminUsers.allStatuses}</SelectItem>
            <SelectItem value="active">{vi.adminUsers.statusActive}</SelectItem>
            <SelectItem value="banned">{vi.adminUsers.statusBanned}</SelectItem>
            <SelectItem value="deleting">{vi.adminUsers.statusDeleting}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState title={debouncedQ || status !== ALL ? vi.common.noResults : vi.adminUsers.empty} />
      ) : (
        <>
          <DataTable rows={list.data.items} columns={columns} rowId={(u) => u.id} />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {page}/{totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {vi.common.back}
              </Button>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                {vi.common.next}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!banTarget}
        onOpenChange={(o) => !o && setBanTarget(null)}
        title={vi.adminUsers.banTitle}
        description={
          <>
            <p className="font-medium text-foreground">{banTarget?.email}</p>
            <p>{vi.adminUsers.banDesc}</p>
          </>
        }
        confirmLabel={vi.adminUsers.ban}
        onConfirm={async () => {
          if (banTarget) await setUserStatus.mutateAsync({ id: banTarget.id, status: 'banned' });
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={vi.adminUsers.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{deleteTarget?.email}</p>
            <p>{vi.adminUsers.deleteDesc}</p>
          </>
        }
        requireText={deleteTarget?.email}
        requireTextLabel={vi.adminUsers.deleteConfirmLabel}
        confirmLabel={vi.adminUsers.deleteUser}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await apiDelete(`/api/admin/users/${deleteTarget.id}?confirm=${encodeURIComponent(deleteTarget.email)}`);
            toast.success(vi.adminUsers.deleteStarted);
            void refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : vi.common.genericError);
          }
        }}
      />

      <ResetPasswordDialog key={resetTarget?.id ?? 'none'} target={resetTarget} onClose={() => setResetTarget(null)} />
    </div>
  );
}

function ResetPasswordDialog({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/users/${target.id}/reset-password`, { method: 'POST', json: { newPassword: password } });
      toast.success(vi.adminUsers.done);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields?.newPassword ?? e.message) : vi.common.genericError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{vi.adminUsers.resetTitle}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{target?.email}</span>
            <br />
            {vi.adminUsers.resetDesc}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reset-password">{vi.adminUsers.newPassword}</Label>
          <Input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <p className="text-xs text-muted-foreground">{vi.auth.passwordHint}</p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {vi.common.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || password.length === 0}>
            {vi.adminUsers.resetPassword}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
