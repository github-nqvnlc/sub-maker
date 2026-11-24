'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, apiPost } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { fmt } from '@/lib/i18n/fmt';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

/** Bản ước tính trước khi tạo voice (POST /api/files/{id}/estimate, spec 003 FR-008). */
export type Estimate = {
  cues: number;
  units: number;
  chars: number;
  billableChars: number;
  cachedUnits: number;
  requests: number;
  audioMs: number;
  outputBytes: number;
  quotaOk: boolean;
  needBytes?: number;
  etaMs: number;
  priceConfigured: boolean;
  price: number | null;
};

export type EstimateBody = {
  providerType?: string;
  model: string | null;
  voice: string;
  speed: number | null;
  customProviderId?: string;
  timing?: { mode: 'timed' | 'continuous'; mergeCues?: boolean };
};

/** Tính lại ước tính mỗi khi lựa chọn đổi (react-query tự hủy kết quả cũ theo khóa). */
export function useEstimate(fileId: string, body: EstimateBody, enabled: boolean) {
  return useQuery({
    queryKey: ['estimate', fileId, body],
    enabled: enabled && !!fileId && !!body.voice,
    queryFn: () => apiPost<Estimate>(`/api/files/${fileId}/estimate`, body),
    staleTime: 0,
    retry: false,
  });
}

/** Thời gian xử lý hiển thị theo phút (làm tròn lên), tối thiểu 1 phút khi có việc phải làm. */
function fmtEta(t: Dict, ms: number): string {
  if (ms <= 0) return '—';
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return fmt(t.jobs.estimateAbout, { t: `${minutes} ${t.jobs.minutesUnit}` });
}

const fmtMoney = (usd: number) => `${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} USD`;

export function EstimatePanel({ query }: { query: ReturnType<typeof useEstimate> }) {
  const t = useT();
  return (
    <section aria-label={t.jobs.estimateTitle} className="space-y-2 rounded-lg border p-3">
      <h3 className="text-sm font-medium">{t.jobs.estimateTitle}</h3>
      {query.isPending && query.fetchStatus !== 'idle' ? (
        <div className="space-y-2" aria-busy="true" aria-label={t.jobs.estimateLoading}>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : query.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {query.error instanceof ApiError ? query.error.message : t.jobs.estimateError}
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.common.retry}
          </Button>
        </div>
      ) : query.data ? (
        <Body e={query.data} />
      ) : null}
    </section>
  );
}

function Body({ e }: { e: Estimate }) {
  const t = useT();
  const fx = useFormat();
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t.jobs.estimateChars}</dt>
        <dd className="text-right tabular-nums">{fx.number(e.chars)}</dd>
        <dt className="text-muted-foreground">{t.jobs.estimateUnits}</dt>
        <dd className="text-right tabular-nums">{fx.number(e.units)}</dd>
        <dt className="text-muted-foreground">{t.jobs.estimateRequests}</dt>
        <dd className="text-right tabular-nums">{fx.number(e.requests)}</dd>
        <dt className="text-muted-foreground">{t.jobs.estimateAudio}</dt>
        <dd className="text-right tabular-nums">{fmtDuration(e.audioMs)}</dd>
        <dt className="text-muted-foreground">{t.jobs.estimateSize}</dt>
        <dd className="text-right tabular-nums">{fmtBytes(e.outputBytes)}</dd>
        <dt className="text-muted-foreground">{t.jobs.estimateEta}</dt>
        <dd className="text-right tabular-nums">{fmtEta(t, e.etaMs)}</dd>
        <dt className="text-muted-foreground">{t.jobs.estimatePrice}</dt>
        <dd className="text-right tabular-nums">{e.priceConfigured && e.price != null ? fmtMoney(e.price) : t.jobs.estimatePriceNone}</dd>
      </dl>
      {e.cachedUnits > 0 ? <p className="text-xs text-muted-foreground">{fmt(t.jobs.estimateCached, { n: e.cachedUnits })}</p> : null}
      {!e.quotaOk ? (
        <p role="alert" className="text-sm text-destructive">
          {fmt(t.jobs.estimateQuota, { size: fmtBytes(e.needBytes ?? 0) })}
        </p>
      ) : null}
    </>
  );
}
