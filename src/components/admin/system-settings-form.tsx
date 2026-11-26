'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api, apiPut } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';

type Settings = {
  maxFileBytes: number;
  userQuotaBytes: number;
  maxConcurrentJobs: number;
  maxJobsPerUser: number;
  maxSttJobsPerUser: number;
  maxOverlayJobsPerUser: number;
  maxConcurrentOverlayJobs: number;
  overlayMaxMinutes: number;
  overlayMaxMinutesTransparent: number;
  segmentConcurrency: number;
  timingMaxSlipMs: number;
  timingMaxCompressPct: number;
  timingPartMinutes: number;
  timingMergeGapMs: number;
  rpmFptMarketplace: number;
  rpmShopaikeyOpenai: number;
  rpmShopaikeyMinimax: number;
  userVideoQuotaBytes: number;
  videoSystemCapBytes: number;
  videoMaxBytes: number;
  videoMaxMinutes: number;
  videoMaxJobsPerUser: number;
  maxConcurrentVideoRenders: number;
  maxConcurrentVideoTranslations: number;
  videoSourceRetainHours: number;
  videoIdleRetainDays: number;
  videoOutputRetainDays: number;
  videoProviderMaxMinutes: number;
  videoGlossaryMaxPairs: number;
  videoGlossaryMaxChars: number;
};
type Field = { key: keyof Settings; label: string; hint: string; unit: 'mb' | 'gb' | 'int'; min: number; max?: number };

const MB = 1024 * 1024;
const GB = 1024 * MB;
const fieldsOf = (t: Dict): Field[] => [
  { key: 'maxFileBytes', label: t.adminSettings.maxFileBytes, hint: t.adminSettings.maxFileBytesHint, unit: 'mb', min: 0.001, max: 50 },
  { key: 'userQuotaBytes', label: t.adminSettings.userQuotaBytes, hint: t.adminSettings.userQuotaHint, unit: 'mb', min: 1 },
  { key: 'maxConcurrentJobs', label: t.adminSettings.maxConcurrentJobs, hint: t.adminSettings.concurrencyHint, unit: 'int', min: 1, max: 50 },
  { key: 'maxJobsPerUser', label: t.adminSettings.maxJobsPerUser, hint: t.adminSettings.concurrencyHint, unit: 'int', min: 1, max: 50 },
  { key: 'maxSttJobsPerUser', label: t.adminSettings.maxSttJobsPerUser, hint: t.adminSettings.sttJobsHint, unit: 'int', min: 1, max: 20 },
  // Video overlay (spec 005)
  { key: 'maxOverlayJobsPerUser', label: t.adminSettings.maxOverlayJobsPerUser, hint: t.adminSettings.overlayJobsHint, unit: 'int', min: 1, max: 20 },
  { key: 'maxConcurrentOverlayJobs', label: t.adminSettings.maxConcurrentOverlayJobs, hint: t.adminSettings.overlayConcurrencyHint, unit: 'int', min: 1, max: 10 },
  { key: 'overlayMaxMinutes', label: t.adminSettings.overlayMaxMinutes, hint: t.adminSettings.overlayMinutesHint, unit: 'int', min: 1, max: 180 },
  { key: 'overlayMaxMinutesTransparent', label: t.adminSettings.overlayMaxMinutesTransparent, hint: t.adminSettings.overlayMinutesTransparentHint, unit: 'int', min: 1, max: 60 },
  { key: 'segmentConcurrency', label: t.adminSettings.segmentConcurrency, hint: t.adminSettings.segmentHint, unit: 'int', min: 1, max: 16 },
  // Voice khớp mốc thời gian phụ đề (spec 003)
  { key: 'timingMaxSlipMs', label: t.adminSettings.timingMaxSlipMs, hint: t.adminSettings.timingMaxSlipHint, unit: 'int', min: 100, max: 2000 },
  { key: 'timingMaxCompressPct', label: t.adminSettings.timingMaxCompressPct, hint: t.adminSettings.timingMaxCompressHint, unit: 'int', min: 100, max: 150 },
  { key: 'timingPartMinutes', label: t.adminSettings.timingPartMinutes, hint: t.adminSettings.timingPartHint, unit: 'int', min: 1, max: 30 },
  { key: 'timingMergeGapMs', label: t.adminSettings.timingMergeGapMs, hint: t.adminSettings.timingMergeGapHint, unit: 'int', min: 200, max: 3000 },
  { key: 'rpmFptMarketplace', label: t.adminSettings.rpmFptMarketplace, hint: t.adminSettings.rpmHint, unit: 'int', min: 0, max: 600 },
  { key: 'rpmShopaikeyOpenai', label: t.adminSettings.rpmShopaikeyOpenai, hint: t.adminSettings.rpmHint, unit: 'int', min: 0, max: 600 },
  { key: 'rpmShopaikeyMinimax', label: t.adminSettings.rpmShopaikeyMinimax, hint: t.adminSettings.rpmHint, unit: 'int', min: 0, max: 600 },
  // Dịch video (spec 006)
  { key: 'userVideoQuotaBytes', label: t.adminSettings.userVideoQuotaBytes, hint: t.adminSettings.userVideoQuotaHint, unit: 'gb', min: 1, max: 1024 },
  { key: 'videoSystemCapBytes', label: t.adminSettings.videoSystemCapBytes, hint: t.adminSettings.videoSystemCapHint, unit: 'gb', min: 1, max: 10240 },
  { key: 'videoMaxBytes', label: t.adminSettings.videoMaxBytes, hint: t.adminSettings.videoMaxBytesHint, unit: 'gb', min: 0.098, max: 10 },
  { key: 'videoMaxMinutes', label: t.adminSettings.videoMaxMinutes, hint: t.adminSettings.videoMaxMinutesHint, unit: 'int', min: 1, max: 1000 },
  { key: 'videoProviderMaxMinutes', label: t.adminSettings.videoProviderMaxMinutes, hint: t.adminSettings.videoProviderMaxMinutesHint, unit: 'int', min: 1, max: 1000 },
  { key: 'videoMaxJobsPerUser', label: t.adminSettings.videoMaxJobsPerUser, hint: t.adminSettings.videoMaxJobsHint, unit: 'int', min: 1, max: 10 },
  { key: 'maxConcurrentVideoTranslations', label: t.adminSettings.maxConcurrentVideoTranslations, hint: t.adminSettings.videoTranslationsHint, unit: 'int', min: 1, max: 10 },
  { key: 'maxConcurrentVideoRenders', label: t.adminSettings.maxConcurrentVideoRenders, hint: t.adminSettings.videoRendersHint, unit: 'int', min: 1, max: 4 },
  { key: 'videoSourceRetainHours', label: t.adminSettings.videoSourceRetainHours, hint: t.adminSettings.videoSourceRetainHint, unit: 'int', min: 1, max: 720 },
  { key: 'videoIdleRetainDays', label: t.adminSettings.videoIdleRetainDays, hint: t.adminSettings.videoRetainDaysHint, unit: 'int', min: 1, max: 90 },
  { key: 'videoOutputRetainDays', label: t.adminSettings.videoOutputRetainDays, hint: t.adminSettings.videoRetainDaysHint, unit: 'int', min: 1, max: 90 },
  { key: 'videoGlossaryMaxPairs', label: t.adminSettings.videoGlossaryMaxPairs, hint: t.adminSettings.videoGlossaryPairsHint, unit: 'int', min: 1, max: 1000 },
  { key: 'videoGlossaryMaxChars', label: t.adminSettings.videoGlossaryMaxChars, hint: t.adminSettings.videoGlossaryCharsHint, unit: 'int', min: 500, max: 10000 },
];

const toDisplay = (f: Field, v: number) => String(f.unit === 'mb' ? +(v / MB).toFixed(3) : f.unit === 'gb' ? +(v / GB).toFixed(3) : v);
// dung lượng theo GB nhập vào được làm tròn tới MB
const toStored = (f: Field, text: string) => (f.unit === 'mb' ? Math.round(Number(text) * MB) : f.unit === 'gb' ? Math.round(Number(text) * 1024) * MB : Number(text));
// ô GB không sửa thì gửi lại đúng giá trị đang lưu: số hiển thị đã làm tròn, quy đổi ngược sẽ làm lệch
const toSend = (f: Field, text: string, stored: number) => (f.unit === 'gb' && text === toDisplay(f, stored) ? stored : toStored(f, text));

/** Cài đặt hệ thống (FR-043): chỉnh giới hạn tệp, hạn mức lưu trữ, số tiến trình đồng thời; có hiệu lực ngay. */
export function SystemSettingsForm() {
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  if (q.isPending) return <LoadingList rows={3} />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  return <Form initial={q.data} />;
}

function Form({ initial }: { initial: Settings }) {
  const t = useT();
  const FIELDS = fieldsOf(t);
  const qc = useQueryClient();
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, toDisplay(f, initial[f.key])])));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const invalid = (f: Field): boolean => {
    const n = Number(text[f.key]);
    if (!Number.isFinite(n) || text[f.key] === '' || n < f.min || (f.max !== undefined && n > f.max)) return true;
    return f.unit === 'int' && !Number.isInteger(n);
  };
  const anyInvalid = FIELDS.some(invalid);

  const save = useMutation({
    mutationFn: () => apiPut<Settings>('/api/admin/settings', Object.fromEntries(FIELDS.map((f) => [f.key, toSend(f, text[f.key]!, initial[f.key])]))),
    onSuccess: (data) => {
      toast.success(t.adminSettings.saved);
      qc.setQueryData(['admin-settings'], data);
      setText(Object.fromEntries(FIELDS.map((f) => [f.key, toDisplay(f, data[f.key])])));
      setErrors({});
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : t.common.genericError);
    },
  });

  return (
    <div className="w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t.adminSettings.title}</h1>
        <p className="text-sm text-muted-foreground">{t.adminSettings.subtitle}</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setErrors({});
          save.mutate();
        }}
        className="w-full"
      >
        <Card className="w-full">
          <CardContent className="space-y-6 p-6">
            <div className="grid w-full grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {FIELDS.map((f) => (
                <div key={f.key} className="w-full space-y-1.5">
                  <Label htmlFor={`set-${f.key}`} className="font-medium">
                    {f.label}
                  </Label>
                  <Input
                    id={`set-${f.key}`}
                    inputMode="decimal"
                    value={text[f.key]}
                    aria-invalid={invalid(f) || !!errors[f.key]}
                    onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
                    className="w-full"
                  />
                  <p className="text-xs text-muted-foreground">{f.hint}</p>
                  {invalid(f) ? <p className="text-xs text-destructive">{t.adminSettings.invalid}</p> : null}
                  {errors[f.key] ? <p className="text-xs text-destructive">{errors[f.key]}</p> : null}
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t pt-4">
              <Button type="submit" disabled={save.isPending || anyInvalid} size="lg">
                {save.isPending ? t.common.loading : t.adminSettings.save}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
