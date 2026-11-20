'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CreateProjectDialog } from '@/components/projects/create-project-dialog';
import { EditProjectDialog } from '@/components/projects/edit-project-dialog';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { api, apiPost } from '@/lib/api-client';
import { useProviders } from '@/lib/hooks/use-providers';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  providerType: string;
  voiceCount: number;
  runningJobs: number;
  failedJobs: number;
  createdAt: string;
  updatedAt: string;
};
type ListResult = { items: ProjectSummary[]; total: number; page: number; pageSize: number };

const PAGE_SIZE = 20;
const ALL = 'all';

const sortOptions = (t: Dict) =>
  [
    { value: 'updatedAt', label: t.projects.sortUpdated },
    { value: 'createdAt', label: t.projects.sortCreated },
    { value: 'name', label: t.projects.sortName },
    { value: 'voiceCount', label: t.projects.sortVoices },
  ] as const;

/**
 * Danh sách Project: tìm kiếm (gõ không dấu được), sắp xếp, lọc, phân trang, chọn nhiều để xóa hàng loạt
 * (FR-004..008). Bộ lọc nằm trên URL nên làm mới/chia sẻ liên kết vẫn giữ nguyên.
 */
export function ProjectsList() {
  const t = useT();
  const fx = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const providers = useProviders();

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'updatedAt';
  const order = params.get('order') ?? 'desc';
  const provider = params.get('provider') ?? ALL;
  const jobState = params.get('jobState') ?? ALL;
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const [search, setSearch] = useState(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<ProjectSummary | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);

  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '' || v === ALL) next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page'); // đổi bộ lọc thì về trang 1
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    setSelected(new Set());
  }

  // Gõ tìm kiếm: chờ 300 ms rồi mới đẩy lên URL
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => setParams({ q: search.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const apiQuery = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, order });
  if (q) apiQuery.set('q', q);
  if (provider !== ALL) apiQuery.set('provider', provider);
  if (jobState !== ALL) apiQuery.set('jobState', jobState);

  const list = useQuery({
    queryKey: ['projects', apiQuery.toString()],
    queryFn: () => api<ListResult>(`/api/projects?${apiQuery}`),
    // Cập nhật định kỳ khi còn tiến trình đang chạy để chỉ báo luôn đúng
    refetchInterval: (query) => (query.state.data?.items.some((p) => p.runningJobs > 0) ? 4000 : false),
  });

  const del = useMutation({
    mutationFn: (ids: string[]) => apiPost<{ deleted: string[]; notFound: string[]; busy: string[] }>('/api/projects/bulk-delete', { ids }),
    onSuccess: (r, ids) => {
      toast.success(ids.length > 1 ? t.projects.deletedMany : t.projects.deleted);
      if (r.busy.length > 0) toast.error(t.projects.deleteBusy);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  const filtered = q !== '' || provider !== ALL || jobState !== ALL;

  const columns: Column<ProjectSummary>[] = [
    {
      key: 'name',
      header: t.projects.colName,
      cell: (p) => (
        <div className="min-w-0 max-w-xs">
          <Link href={`/projects/${p.id}`} className="block truncate font-medium hover:underline">
            {p.name}
          </Link>
          {p.description ? <p className="line-clamp-1 text-xs text-muted-foreground">{p.description}</p> : null}
        </div>
      ),
    },
    {
      key: 'provider',
      header: t.projects.colProvider,
      cell: (p) => <Badge variant="secondary">{providers.data?.find((x) => x.type === p.providerType)?.label ?? p.providerType}</Badge>,
      className: 'hidden md:table-cell',
    },
    { key: 'voices', header: t.projects.colVoices, cell: (p) => <span className="tabular-nums">{p.voiceCount}</span> },
    {
      key: 'state',
      header: t.projects.colState,
      cell: (p) =>
        p.runningJobs > 0 || p.failedJobs > 0 ? (
          <div className="flex flex-wrap gap-1">
            {p.runningJobs > 0 ? <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">{t.projects.running}</Badge> : null}
            {p.failedJobs > 0 ? <Badge variant="destructive">{t.projects.failed}</Badge> : null}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    { key: 'updated', header: t.projects.colUpdated, cell: (p) => <span className="whitespace-nowrap text-xs">{fx.dateTime(p.updatedAt)}</span>, className: 'hidden lg:table-cell' },
    {
      key: 'actions',
      header: '',
      cell: (p) => (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setEdit(p)}>
            {t.common.edit}
          </Button>
          <Button size="icon" variant="ghost" aria-label={t.projects.delete} onClick={() => setConfirmIds([p.id])}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const confirmNames = (list.data?.items ?? []).filter((p) => confirmIds?.includes(p.id)).map((p) => p.name);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{t.projects.title}</h1>
          <p className="text-sm text-muted-foreground">{t.projects.subtitle}</p>
        </div>
        <CreateProjectDialog />
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.projects.searchPlaceholder}
          aria-label={t.common.search}
          className="w-full sm:max-w-xs"
        />
        <Select value={sort} onValueChange={(v) => setParams({ sort: v })}>
          <SelectTrigger className="w-40" aria-label={t.projects.sortBy}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions(t).map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={order} onValueChange={(v) => setParams({ order: v })}>
          <SelectTrigger className="w-32" aria-label={t.projects.sortBy}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="asc">{t.projects.asc}</SelectItem>
            <SelectItem value="desc">{t.projects.desc}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={provider} onValueChange={(v) => setParams({ provider: v })}>
          <SelectTrigger className="w-44" aria-label={t.projects.provider}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.projects.allProviders}</SelectItem>
            {(providers.data ?? []).map((p) => (
              <SelectItem key={p.type} value={p.type}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={jobState} onValueChange={(v) => setParams({ jobState: v })}>
          <SelectTrigger className="w-44" aria-label={t.projects.colState}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.projects.allStates}</SelectItem>
            <SelectItem value="running">{t.projects.stateRunning}</SelectItem>
            <SelectItem value="failed">{t.projects.stateFailed}</SelectItem>
            <SelectItem value="none">{t.projects.stateNone}</SelectItem>
          </SelectContent>
        </Select>
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              router.replace(pathname);
              setSelected(new Set());
            }}
          >
            {t.common.clearFilters}
          </Button>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <div className="flex items-center justify-between rounded-lg border bg-accent/40 px-3 py-2" role="status">
          <span className="text-sm">
            {selected.size} {t.projects.selectedCount}
          </span>
          <Button size="sm" variant="destructive" onClick={() => setConfirmIds([...selected])}>
            <Trash2 className="size-4" />
            {t.projects.deleteSelected}
          </Button>
        </div>
      ) : null}

      {list.isPending ? (
        <LoadingList />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        filtered ? (
          <EmptyState
            title={t.common.noResults}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setSearch('');
                  router.replace(pathname);
                }}
              >
                {t.common.clearFilters}
              </Button>
            }
          />
        ) : (
          <EmptyState icon={FolderOpen} title={t.projects.emptyTitle} description={t.projects.emptyDesc} action={<CreateProjectDialog />} />
        )
      ) : (
        <>
          <DataTable
            rows={list.data.items}
            columns={columns}
            rowId={(p) => p.id}
            selected={selected}
            onSelectedChange={setSelected}
            selectAllLabel={t.projects.selectAll}
            selectLabel={t.projects.selectRow}
          />
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {list.data.total} · {page}/{totalPages}
            </span>
            {totalPages > 1 ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>
                  {t.common.back}
                </Button>
                <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setParams({ page: String(page + 1) })}>
                  {t.common.next}
                </Button>
              </div>
            ) : null}
          </div>
        </>
      )}

      <EditProjectDialog project={edit} onClose={() => setEdit(null)} />

      <ConfirmDialog
        open={!!confirmIds}
        onOpenChange={(o) => !o && setConfirmIds(null)}
        title={confirmIds && confirmIds.length > 1 ? t.projects.deleteManyTitle : t.projects.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">
              {confirmIds?.length ?? 0} Project{confirmNames.length > 0 ? `: ${confirmNames.slice(0, 5).join(', ')}${confirmNames.length > 5 ? '…' : ''}` : ''}
            </p>
            <p>{t.projects.deleteDesc}</p>
          </>
        }
        confirmLabel={t.projects.delete}
        onConfirm={async () => {
          if (confirmIds) await del.mutateAsync(confirmIds);
        }}
      />
    </div>
  );
}
