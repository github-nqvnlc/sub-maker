'use client';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n/client';

export type TimingChoice = { timed: boolean; mergeCues: boolean };

/**
 * Hai công tắc của chế độ khớp mốc thời gian phụ đề (spec 003, FR-003/FR-007): "Khớp mốc thời gian phụ đề" và
 * "Ghép cue cùng câu". Dùng chung cho hộp thoại tạo voice và hộp thoại sửa thiết lập.
 * `available=false` (tệp không có mốc hợp lệ) ⇒ tắt kèm lý do.
 */
export function TimingOptions({
  idPrefix,
  value,
  onChange,
  available,
}: {
  idPrefix: string;
  value: TimingChoice;
  onChange: (v: TimingChoice) => void;
  available: boolean;
}) {
  const t = useT();
  const timed = available && value.timed;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${idPrefix}-timed`}>{t.jobs.timingLabel}</Label>
          <Switch id={`${idPrefix}-timed`} checked={timed} disabled={!available} onCheckedChange={(c) => onChange({ ...value, timed: c })} />
        </div>
        <p className="text-xs text-muted-foreground">{available ? t.jobs.timingHint : t.jobs.timingUnavailable}</p>
      </div>
      {timed ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${idPrefix}-merge`}>{t.jobs.mergeCuesLabel}</Label>
            <Switch id={`${idPrefix}-merge`} checked={value.mergeCues} onCheckedChange={(c) => onChange({ ...value, mergeCues: c })} />
          </div>
          <p className="text-xs text-muted-foreground">{t.jobs.mergeCuesHint}</p>
        </div>
      ) : null}
    </div>
  );
}
