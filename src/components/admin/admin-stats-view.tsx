'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RangePicker, lastDays, type DateRange } from '@/components/dashboard/range-picker';
import { StatCard, fmtNum, fmtUsd } from '@/components/dashboard/stat-card';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { api } from '@/lib/api-client';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { vi } from '@/lib/i18n/vi';

type Stats = {
  totals: {
    users: number;
    projects: number;
    voices: number;
    chars: number;
    tokens: number | null;
    costEstimateUsd: number | null;
    storageUsedBytes: number;
    charsByScope: { global: number; user: number };
  };
  users: {
    user: { id: string; email: string; displayName: string; role: 'admin' | 'user'; status: string; lastActiveAt: string | null };
    projects: number;
    voices: number;
    chars: number;
    charsByScope: { global: number; user: number };
    costEstimateUsd: number | null;
    storageUsedBytes: number;
  }[];
};

const SORTS = [
  { value: 'chars', label: vi.adminStats.chars },
  { value: 'projects', label: vi.adminStats.projects },
  { value: 'voices', label: vi.adminStats.voices },
  { value: 'cost', label: vi.adminStats.cost },
  { value: 'storage', label: vi.adminStats.storage },
  { value: 'lastActive', label: vi.adminStats.lastActive },
] as const;

const usd = (n: number | null) => (n === null ? '—' : fmtUsd(n));

/** Thống kê Administrator (FR-039): tổng hợp toàn hệ thống + từng User; chỉ số liệu, không có nội dung Project. */
export function AdminStatsView() {
  const [range, setRange] = useState<DateRange>(() => lastDays(30));
  const [sort, setSort] = useState<string>('chars');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const q = useQuery({
    queryKey: ['admin-stats', range, sort, order],
    queryFn: () => api<Stats>(`/api/admin/stats?from=${range.from}&to=${range.to}&sort=${sort}&order=${order}`),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{vi.adminStats.title}</h1>
          <p className="text-sm text-muted-foreground">{vi.adminStats.subtitle}</p>
        </div>
        <RangePicker value={range} onChange={setRange} />
      </div>

      {q.isPending ? (
        <LoadingList rows={4} />
      ) : q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={vi.adminStats.users} value={fmtNum(q.data.totals.users)} testId="admin-stat-users" />
            <StatCard label={vi.adminStats.projects} value={fmtNum(q.data.totals.projects)} testId="admin-stat-projects" />
            <StatCard label={vi.adminStats.voices} value={fmtNum(q.data.totals.voices)} testId="admin-stat-voices" />
            <StatCard label={vi.adminStats.storage} value={fmtBytes(q.data.totals.storageUsedBytes)} testId="admin-stat-storage" />
            <StatCard label={vi.adminStats.chars} value={fmtNum(q.data.totals.chars)} testId="admin-stat-chars" />
            <StatCard label={vi.adminStats.scopeGlobal} value={fmtNum(q.data.totals.charsByScope.global)} testId="admin-stat-global" />
            <StatCard label={vi.adminStats.scopeUser} value={fmtNum(q.data.totals.charsByScope.user)} testId="admin-stat-own" />
            <StatCard
              label={vi.adminStats.cost}
              value={q.data.totals.costEstimateUsd === null ? vi.dashboard.costNA : fmtUsd(q.data.totals.costEstimateUsd)}
              muted={q.data.totals.costEstimateUsd === null}
              testId="admin-stat-cost"
            />
          </div>
          <p className="text-xs text-muted-foreground">{vi.adminStats.anonymizedNote}</p>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-56" aria-label={vi.adminStats.sortBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {vi.adminStats.sortBy}: {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setOrder(order === 'desc' ? 'asc' : 'desc')}>
              {order === 'desc' ? vi.projects.desc : vi.projects.asc}
            </Button>
          </div>

          {q.data.users.length === 0 ? (
            <EmptyState title={vi.adminStats.empty} />
          ) : (
            <div className="w-full overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{vi.adminStats.colUser}</TableHead>
                    <TableHead className="text-right">{vi.adminStats.projects}</TableHead>
                    <TableHead className="text-right">{vi.adminStats.voices}</TableHead>
                    <TableHead className="text-right">{vi.adminStats.colGlobal}</TableHead>
                    <TableHead className="text-right">{vi.adminStats.colOwn}</TableHead>
                    <TableHead className="text-right">{vi.adminStats.cost}</TableHead>
                    <TableHead className="text-right">{vi.adminStats.storage}</TableHead>
                    <TableHead>{vi.adminStats.lastActive}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.users.map((r) => (
                    <TableRow key={r.user.id} data-testid="admin-stat-row">
                      <TableCell>
                        <div className="font-medium">{r.user.displayName}</div>
                        <div className="text-xs text-muted-foreground">{r.user.email}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.projects)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.voices)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.charsByScope.global)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.charsByScope.user)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(r.costEstimateUsd)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBytes(r.storageUsedBytes)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{r.user.lastActiveAt ? fmtDateTime(r.user.lastActiveAt) : vi.adminStats.never}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
