'use client';

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SwitchRow } from '@/components/overlay/fields';
import { WarningList } from '@/components/overlay/warning-list';
import { ApiError } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { newRequestId, useOverlayActions, type OverlayLimits, type OverlaySource } from '@/lib/hooks/use-overlay';
import { fmt } from '@/lib/i18n/fmt';
import { useT } from '@/lib/i18n/client';
import { isTransparent, type OverlayConfig } from '@/lib/overlay/config';
import { estimateBytes } from '@/lib/overlay/estimate';
import type { OverlayWarning } from '@/lib/overlay/types';

/** Ước tính, lưu ý và nút xuất (FR-033, FR-034, FR-044). Máy chủ luôn kiểm tra lại mọi giới hạn. */
export function ExportPanel({
  projectId,
  config,
  onChange,
  source,
  durationMs,
  limits,
  warnings,
}: {
  projectId: string;
  config: OverlayConfig;
  onChange: (c: OverlayConfig) => void;
  source: OverlaySource;
  /** null khi chưa có mốc phụ đề (chưa chọn đủ nguồn hoặc đang tải) */
  durationMs: number | null;
  limits: OverlayLimits;
  warnings: readonly OverlayWarning[];
}) {
  const t = useT();
  const { create } = useOverlayActions(projectId);
  // Lỗi gắn với đúng cấu hình và nguồn lúc gửi: đổi lựa chọn thì lỗi cũ không còn hiện
  const [failure, setFailure] = useState<{ text: string; config: OverlayConfig; source: OverlaySource } | null>(null);
  const error = failure && failure.config === config && failure.source === source ? failure.text : null;
  // Giữ nguyên mã cho tới khi máy chủ trả lời: mất mạng rồi bấm lại không tạo hai lần xuất
  const requestId = useRef<string | null>(null);

  const estimate = durationMs === null ? null : estimateBytes(config, durationMs);
  const remaining = Math.max(0, limits.quotaBytes - limits.usedBytes - limits.pendingBytes);
  const maxMinutes = isTransparent(config) ? limits.maxMinutesTransparent : limits.maxMinutes;
  const tooLong = durationMs !== null && durationMs > maxMinutes * 60_000;
  const overQuota = estimate !== null && estimate > remaining;
  const quotaText = (left: number, need: number) =>
    [fmt(t.overlay.quotaBlocked, { remaining: fmtBytes(left), estimate: fmtBytes(need), need: fmtBytes(Math.max(0, need - left)) }), config.format === 'mov' ? t.overlay.quotaMovHint : '']
      .filter(Boolean)
      .join(' ');
  const blocked = tooLong ? fmt(t.overlay.tooLong, { minutes: maxMinutes }) : overQuota ? quotaText(remaining, estimate) : null;

  function start() {
    if (!source.fileId) return;
    const setError = (text: string) => setFailure({ text, config, source });
    setFailure(null);
    requestId.current ??= newRequestId();
    create.mutate(
      { ...source, config, clientRequestId: requestId.current },
      {
        onSuccess: () => {
          requestId.current = null;
          toast.success(t.overlay.exportStarted);
        },
        onError: (e) => {
          if (!(e instanceof ApiError)) return setError(t.common.genericError);
          requestId.current = null;
          const f = e.fields;
          if (e.code === 'QUOTA_EXCEEDED' && f?.remainingBytes && f.estimateBytes) return setError(quotaText(Number(f.remainingBytes), Number(f.estimateBytes)));
          if (e.code === 'OVERLAY_TOO_LONG' && f?.maxMinutes) return setError(fmt(t.overlay.tooLong, { minutes: f.maxMinutes }));
          setError(e.code === 'VALIDATION' && f ? Object.values(f).join('. ') : e.message);
        },
      },
    );
  }

  return (
    <section className="space-y-3" aria-labelledby="overlay-export-title">
      <h2 id="overlay-export-title" className="text-base font-semibold">
        {t.overlay.exportTitle}
      </h2>
      <Card>
        <CardContent className="space-y-4 p-5">
          <SwitchRow id="ov-include-audio" label={t.overlay.includeAudio} hint={t.overlay.includeAudioHint} checked={config.includeAudio} onChange={(includeAudio) => onChange({ ...config, includeAudio })} />

          <section aria-label={t.overlay.estimateTitle} className="space-y-2 rounded-lg border p-3">
            <h3 className="text-sm font-medium">{t.overlay.estimateTitle}</h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t.overlay.duration}</dt>
              <dd className="text-right tabular-nums" data-testid="overlay-duration">
                {durationMs === null ? '—' : fmtDuration(durationMs)}
              </dd>
              <dt className="text-muted-foreground">{t.overlay.estimate}</dt>
              <dd className="text-right tabular-nums" data-testid="overlay-estimate">
                {estimate === null ? '—' : `~${fmtBytes(estimate)}`}
              </dd>
              <dt className="text-muted-foreground">{t.overlay.remaining}</dt>
              <dd className="text-right tabular-nums" data-testid="overlay-remaining">
                {fmtBytes(remaining)}
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">{t.overlay.estimateNote}</p>
          </section>

          <WarningList title={t.overlay.warningsTitle} warnings={warnings} />

          {(blocked ?? error) ? (
            <p role="alert" className="text-sm text-destructive">
              {blocked ?? error}
            </p>
          ) : null}

          <div className="flex justify-end pt-2">
            <Button disabled={durationMs === null || !!blocked || create.isPending} onClick={start}>
              {create.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t.overlay.exporting}
                </>
              ) : (
                t.overlay.export
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
