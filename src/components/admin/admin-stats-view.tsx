'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RangePicker, lastDays, type DateRange } from '@/components/dashboard/range-picker';
import { StatCard } from '@/components/dashboard/stat-card';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { api } from '@/lib/api-client';
import { fmtBytes } from '@/lib/format';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

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

const sortOptions = (t: Dict) =>
  [
    { value: 'chars', label: t.adminStats.chars },
    { value: 'projects', label: t.adminStats.projects },
    { value: 'voices', label: t.adminStats.voices },
    { value: 'cost', label: t.adminStats.cost },
    { value: 'storage', label: t.adminStats.storage },
    { value: 'lastActive', label: t.adminStats.lastActive },
  ] as const;

/** Thống kê Administrator (FR-039): tổng hợp toàn hệ thống + từng User; chỉ số liệu, không có nội dung Project. */
export function AdminStatsView() {
  const t = useT();
  const fx = useFormat();
  const usd = (n: number | null) => (n === null ? '—' : fx.usd(n));
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
          <h1 className="text-2xl font-semibold">{t.adminStats.title}</h1>
          <p className="text-sm text-muted-foreground">{t.adminStats.subtitle}</p>
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
            <StatCard label={t.adminStats.users} value={fx.number(q.data.totals.users)} testId="admin-stat-users" />
            <StatCard label={t.adminStats.projects} value={fx.number(q.data.totals.projects)} testId="admin-stat-projects" />
            <StatCard label={t.adminStats.voices} value={fx.number(q.data.totals.voices)} testId="admin-stat-voices" />
            <StatCard label={t.adminStats.storage} value={fmtBytes(q.data.totals.storageUsedBytes)} testId="admin-stat-storage" />
            <StatCard label={t.adminStats.chars} value={fx.number(q.data.totals.chars)} testId="admin-stat-chars" />
            <StatCard label={t.adminStats.scopeGlobal} value={fx.number(q.data.totals.charsByScope.global)} testId="admin-stat-global" />
            <StatCard label={t.adminStats.scopeUser} value={fx.number(q.data.totals.charsByScope.user)} testId="admin-stat-own" />
            <StatCard
              label={t.adminStats.cost}
              value={q.data.totals.costEstimateUsd === null ? t.dashboard.costNA : fx.usd(q.data.totals.costEstimateUsd)}
              muted={q.data.totals.costEstimateUsd === null}
              testId="admin-stat-cost"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t.adminStats.anonymizedNote}</p>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-56" aria-label={t.adminStats.sortBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortOptions(t).map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {t.adminStats.sortBy}: {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setOrder(order === 'desc' ? 'asc' : 'desc')}>
              {order === 'desc' ? t.projects.desc : t.projects.asc}
            </Button>
          </div>

          {q.data.users.length === 0 ? (
            <EmptyState title={t.adminStats.empty} />
          ) : (
            <div className="w-full overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.adminStats.colUser}</TableHead>
                    <TableHead className="text-right">{t.adminStats.projects}</TableHead>
                    <TableHead className="text-right">{t.adminStats.voices}</TableHead>
                    <TableHead className="text-right">{t.adminStats.colGlobal}</TableHead>
                    <TableHead className="text-right">{t.adminStats.colOwn}</TableHead>
                    <TableHead className="text-right">{t.adminStats.cost}</TableHead>
                    <TableHead className="text-right">{t.adminStats.storage}</TableHead>
                    <TableHead>{t.adminStats.lastActive}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.users.map((r) => (
                    <TableRow key={r.user.id} data-testid="admin-stat-row">
                      <TableCell>
                        <div className="font-medium">{r.user.displayName}</div>
                        <div className="text-xs text-muted-foreground">{r.user.email}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fx.number(r.projects)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fx.number(r.voices)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fx.number(r.charsByScope.global)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fx.number(r.charsByScope.user)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(r.costEstimateUsd)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBytes(r.storageUsedBytes)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{r.user.lastActiveAt ? fx.dateTime(r.user.lastActiveAt) : t.adminStats.never}</TableCell>
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
