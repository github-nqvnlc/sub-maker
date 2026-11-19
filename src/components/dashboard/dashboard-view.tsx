'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RangePicker, lastDays, type DateRange } from '@/components/dashboard/range-picker';
import { StatCard, fmtNum, fmtUsd } from '@/components/dashboard/stat-card';
import { StatusBadge, type JobStatus } from '@/components/jobs/status-badge';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { api } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useProviders } from '@/lib/hooks/use-providers';
import { vi } from '@/lib/i18n/vi';

type Dashboard = {
  projects: number;
  voices: number;
  totalDurationMs: number;
  jobsByStatus: Record<string, number>;
  usage: {
    chars: number;
    tokens: number | null;
    costEstimateUsd: number | null;
    byDay: { date: string; chars: number; costEstimateUsd: number | null }[];
    byProvider: { providerType: string; configScope: 'global' | 'user'; chars: number }[];
  };
  storageUsedBytes: number;
  storageQuotaBytes: number;
};

const chartConfig = { chars: { label: vi.dashboard.chars, color: 'var(--chart-1)' } } satisfies ChartConfig;

/** Dashboard cá nhân (FR-038): chỉ số liệu của chính User; cập nhật định kỳ để thấy mức dùng mới sau khi job xong. */
export function DashboardView() {
  const [range, setRange] = useState<DateRange>(() => lastDays(30));
  const providers = useProviders();
  const q = useQuery({
    queryKey: ['dashboard', range],
    queryFn: () => api<Dashboard>(`/api/dashboard?from=${range.from}&to=${range.to}`),
    refetchInterval: 30_000,
  });

  const providerLabel = (t: string) => providers.data?.find((p) => p.type === t)?.label ?? t;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{vi.dashboard.title}</h1>
          <p className="text-sm text-muted-foreground">{vi.dashboard.subtitle}</p>
        </div>
        <RangePicker value={range} onChange={setRange} />
      </div>

      {q.isPending ? (
        <LoadingList rows={4} />
      ) : q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <Body d={q.data} providerLabel={providerLabel} />
      )}
    </div>
  );
}

function Body({ d, providerLabel }: { d: Dashboard; providerLabel: (t: string) => string }) {
  const pct = d.storageQuotaBytes > 0 ? Math.min(100, (d.storageUsedBytes / d.storageQuotaBytes) * 100) : 0;
  const statuses = Object.entries(d.jobsByStatus);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={vi.dashboard.projects} value={fmtNum(d.projects)} testId="stat-projects" />
        <StatCard label={vi.dashboard.voices} value={fmtNum(d.voices)} testId="stat-voices" />
        <StatCard label={vi.dashboard.totalDuration} value={fmtDuration(d.totalDurationMs)} testId="stat-duration" />
        <StatCard label={vi.dashboard.chars} value={fmtNum(d.usage.chars)} hint={vi.dashboard.charsHint} testId="stat-chars" />
        <StatCard
          label={vi.dashboard.cost}
          value={d.usage.costEstimateUsd === null ? vi.dashboard.costNA : fmtUsd(d.usage.costEstimateUsd)}
          muted={d.usage.costEstimateUsd === null}
          testId="stat-cost"
        />
        <StatCard
          label={vi.dashboard.tokens}
          value={d.usage.tokens === null ? vi.dashboard.tokensNA : fmtNum(d.usage.tokens)}
          muted={d.usage.tokens === null}
          testId="stat-tokens"
        />
        <Card className="sm:col-span-2">
          <CardContent className="space-y-2 p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-muted-foreground">{vi.dashboard.storage}</p>
              <p className="text-sm tabular-nums" data-testid="stat-storage">
                {fmtBytes(d.storageUsedBytes)} {vi.dashboard.storageOf} {fmtBytes(d.storageQuotaBytes)}
              </p>
            </div>
            <Progress value={pct} aria-label={vi.dashboard.storage} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{vi.dashboard.byDay}</CardTitle>
        </CardHeader>
        <CardContent>
          {d.usage.byDay.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{vi.dashboard.noUsage}</p>
          ) : (
            <ChartContainer config={chartConfig} className="h-56 w-full">
              <BarChart data={d.usage.byDay} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis width={48} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="chars" fill="var(--color-chars)" radius={4} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{vi.dashboard.byProvider}</CardTitle>
          </CardHeader>
          <CardContent>
            {d.usage.byProvider.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{vi.dashboard.noUsage}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{vi.dashboard.colProvider}</TableHead>
                    <TableHead>{vi.dashboard.colScope}</TableHead>
                    <TableHead className="text-right">{vi.dashboard.colChars}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.usage.byProvider.map((r) => (
                    <TableRow key={`${r.providerType}:${r.configScope}`}>
                      <TableCell>{providerLabel(r.providerType)}</TableCell>
                      <TableCell>{r.configScope === 'user' ? vi.dashboard.scopeUser : vi.dashboard.scopeGlobal}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.chars)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{vi.dashboard.jobs}</CardTitle>
          </CardHeader>
          <CardContent>
            {statuses.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{vi.dashboard.noJobs}</p>
            ) : (
              <ul className="space-y-2">
                {statuses.map(([status, n]) => (
                  <li key={status} className="flex items-center justify-between">
                    <StatusBadge status={status as JobStatus} />
                    <span className="tabular-nums">{fmtNum(n)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
