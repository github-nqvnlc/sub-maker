'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { api, apiDelete, apiPost } from '@/lib/api-client';
import { fmt } from '@/lib/i18n/fmt';
import { useT } from '@/lib/i18n/client';
import { CustomProviderDialog, type CustomProviderDto } from '@/components/settings/custom-provider-dialog';

type TestResult = { ok: boolean; message: string };

export const useCustomProviders = () => useQuery({ queryKey: ['custom-ai-providers'], queryFn: () => api<CustomProviderDto[]>('/api/admin/custom-ai-providers') });

/** Tab "Nhà cung cấp AI tùy chỉnh" (spec 004, US5): danh sách CRUD, phạm vi sử dụng, kiểm tra kết nối. */
export function CustomProviderTable() {
  const t = useT();
  const qc = useQueryClient();
  const list = useCustomProviders();
  // undefined = đóng hộp thoại, null = thêm mới
  const [editing, setEditing] = useState<CustomProviderDto | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<{ p: CustomProviderDto; pending: number } | null>(null);

  const test = useMutation({
    mutationFn: (id: string) => apiPost<TestResult>(`/api/admin/custom-ai-providers/${id}/test`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${t.aiConfig.testOk} — ${r.message}`);
      else toast.error(`${t.aiConfig.testFail} — ${r.message}`);
      void qc.invalidateQueries({ queryKey: ['custom-ai-providers'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  const askDelete = async (p: CustomProviderDto) => {
    try {
      const r = await api<{ pendingJobs: number }>(`/api/admin/custom-ai-providers/${p.id}`);
      setDeleting({ p, pending: r.pendingJobs });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t.common.genericError);
    }
  };

  const accessLabel = (p: CustomProviderDto) =>
    p.accessMode === 'public'
      ? t.providersAdmin.accessPublic
      : p.accessMode === 'restricted'
        ? `${t.providersAdmin.accessRestricted} · ${fmt(t.providersAdmin.assignedCount, { count: p.assignedUserIds.length })}`
        : t.providersAdmin.accessPrivate;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t.providersAdmin.customDescription}</p>
        <Button size="sm" onClick={() => setEditing(null)}>
          {t.providersAdmin.addProvider}
        </Button>
      </div>

      {list.isPending ? (
        <LoadingList rows={3} />
      ) : list.isError ? (
        <ErrorState message={t.providersAdmin.loadError} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t.providersAdmin.empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  <Badge variant="outline">{accessLabel(p)}</Badge>
                  <Badge variant={p.enabled ? 'default' : 'secondary'}>{p.enabled ? t.aiConfig.enabled : t.aiConfig.disabled}</Badge>
                  {p.lastTestOk != null ? (
                    <Badge variant={p.lastTestOk ? 'secondary' : 'destructive'}>{p.lastTestOk ? t.aiConfig.testOk : t.aiConfig.testFail}</Badge>
                  ) : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {p.baseUrl} · {p.models.join(', ') || '—'} · <code>{p.apiKeyHint}</code>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={test.isPending && test.variables === p.id} onClick={() => test.mutate(p.id)}>
                  {test.isPending && test.variables === p.id ? t.aiConfig.testing : t.aiConfig.test}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                  {t.providersAdmin.editProvider}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void askDelete(p)}>
                  {t.aiConfig.delete}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CustomProviderDialog provider={editing} onClose={() => setEditing(undefined)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={fmt(t.providersAdmin.deleteTitle, { name: deleting?.p.name ?? '' })}
        description={<p>{fmt(t.providersAdmin.deleteDesc, { count: deleting?.pending ?? 0 })}</p>}
        confirmLabel={t.aiConfig.delete}
        onConfirm={async () => {
          if (!deleting) return;
          await apiDelete(`/api/admin/custom-ai-providers/${deleting.p.id}`);
          toast.success(t.providersAdmin.deleted);
          await qc.invalidateQueries({ queryKey: ['custom-ai-providers'] });
        }}
      />
    </div>
  );
}
