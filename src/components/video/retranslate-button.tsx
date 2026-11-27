'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Languages } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/overlay/fields';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ApiError, apiPost } from '@/lib/api-client';
import { fmtDuration } from '@/lib/format';
import { useVideoTab, videoKeys, type VideoJobDetailDto } from '@/lib/hooks/use-video';
import { useFormat, useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import type { RetranslateEstimateDto } from '@/lib/video/retranslate';
import { DIRECTIONS, type Direction } from '@/lib/video/types';

/**
 * "Dịch lại" (spec 006, US5; FR-016): nêu thời lượng, chi phí ước tính và việc phụ đề đang sửa bị thay trước khi gọi. `ensureSaved`
 * lưu nốt phụ đề và trả phiên bản đã lưu để máy chủ từ chối khi nội dung đã đổi ở nơi khác.
 */
export function RetranslateButton({ job, disabled, ensureSaved }: { job: VideoJobDetailDto; disabled: boolean; ensureSaved: () => Promise<number | null> }) {
  const t = useT();
  const fx = useFormat();
  const r = t.video.retranslate;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>(job.direction);
  const estimate = useQuery({
    queryKey: ['video-retranslate-estimate', job.id],
    queryFn: () => apiPost<RetranslateEstimateDto>(`/api/video/jobs/${job.id}/retranslate/estimate`),
    enabled: open,
    gcTime: 0,
  });
  const cost = estimate.data?.costEstimateUsd;
  const tab = useVideoTab(job.projectId);
  // không dịch lại được (thiếu quyền, chưa cấu hình, âm thanh đã xóa cùng video) thì không mời bấm
  if (!tab.data?.allowed || !tab.data.sttConfigured || !job.canRetranslate) return null;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setDirection(job.direction);
          setOpen(true);
        }}
      >
        <Languages className="size-3.5" />
        {r.button}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={r.title}
        description={
          <>
            <SelectField label={t.video.upload.direction} value={direction} onChange={setDirection} options={DIRECTIONS.map((d) => ({ value: d, label: t.video.upload.directions[d] }))} />
            {estimate.isError ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
                <span>{r.estimateError}</span>
                <Button size="sm" variant="outline" disabled={estimate.isFetching} onClick={() => void estimate.refetch()}>
                  {t.common.retry}
                </Button>
              </div>
            ) : !estimate.data ? (
              <p role="status">{r.estimating}</p>
            ) : (
              <>
                <p data-testid="retranslate-duration">{fmt(r.duration, { duration: fmtDuration(estimate.data.durationMs) })}</p>
                <p data-testid="retranslate-cost">{cost === null || cost === undefined ? r.costUnknown : fmt(r.cost, { cost: fx.usd(cost) })}</p>
              </>
            )}
            <p className="font-medium text-foreground">{r.replaces}</p>
            <p>{r.note}</p>
          </>
        }
        confirmLabel={r.confirm}
        // lượt đọc lại lỗi vẫn còn số cũ trong bộ nhớ: không xác nhận theo số đó
        confirmDisabled={estimate.isError || !estimate.data}
        onConfirm={async () => {
          const saved = await ensureSaved();
          if (saved === null) return void toast.error(t.video.export.saveFirst);
          try {
            await apiPost(`/api/video/jobs/${job.id}/retranslate`, { confirm: true, direction, baseRevision: saved });
            toast.success(r.queued);
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : t.common.genericError);
          }
          await qc.invalidateQueries({ queryKey: videoKeys.job(job.id) });
          await qc.invalidateQueries({ queryKey: videoKeys.jobs(job.projectId) });
        }}
      />
    </>
  );
}
