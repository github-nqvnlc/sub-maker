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
import { vi } from '@/lib/i18n/vi';

type Settings = { maxFileBytes: number; userQuotaBytes: number; maxConcurrentJobs: number; maxJobsPerUser: number; segmentConcurrency: number };
type Field = { key: keyof Settings; label: string; hint: string; unit: 'mb' | 'int'; min: number; max?: number };

const MB = 1024 * 1024;
const FIELDS: Field[] = [
  { key: 'maxFileBytes', label: vi.adminSettings.maxFileBytes, hint: vi.adminSettings.maxFileBytesHint, unit: 'mb', min: 0.001, max: 50 },
  { key: 'userQuotaBytes', label: vi.adminSettings.userQuotaBytes, hint: vi.adminSettings.userQuotaHint, unit: 'mb', min: 1 },
  { key: 'maxConcurrentJobs', label: vi.adminSettings.maxConcurrentJobs, hint: vi.adminSettings.concurrencyHint, unit: 'int', min: 1, max: 50 },
  { key: 'maxJobsPerUser', label: vi.adminSettings.maxJobsPerUser, hint: vi.adminSettings.concurrencyHint, unit: 'int', min: 1, max: 50 },
  { key: 'segmentConcurrency', label: vi.adminSettings.segmentConcurrency, hint: vi.adminSettings.segmentHint, unit: 'int', min: 1, max: 16 },
];

const toDisplay = (f: Field, v: number) => String(f.unit === 'mb' ? +(v / MB).toFixed(3) : v);
const toStored = (f: Field, text: string) => (f.unit === 'mb' ? Math.round(Number(text) * MB) : Number(text));

/** Cài đặt hệ thống (FR-043): chỉnh giới hạn tệp, hạn mức lưu trữ, số tiến trình đồng thời; có hiệu lực ngay. */
export function SystemSettingsForm() {
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  if (q.isPending) return <LoadingList rows={3} />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  return <Form initial={q.data} />;
}

function Form({ initial }: { initial: Settings }) {
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
    mutationFn: () => apiPut<Settings>('/api/admin/settings', Object.fromEntries(FIELDS.map((f) => [f.key, toStored(f, text[f.key]!)]))),
    onSuccess: (data) => {
      toast.success(vi.adminSettings.saved);
      qc.setQueryData(['admin-settings'], data);
      setText(Object.fromEntries(FIELDS.map((f) => [f.key, toDisplay(f, data[f.key])])));
      setErrors({});
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : vi.common.genericError);
    },
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{vi.adminSettings.title}</h1>
        <p className="text-sm text-muted-foreground">{vi.adminSettings.subtitle}</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setErrors({});
          save.mutate();
        }}
      >
        <Card>
          <CardContent className="space-y-5 p-5">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`set-${f.key}`}>{f.label}</Label>
                <Input
                  id={`set-${f.key}`}
                  inputMode="decimal"
                  value={text[f.key]}
                  aria-invalid={invalid(f) || !!errors[f.key]}
                  onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
                  className="max-w-48"
                />
                <p className="text-xs text-muted-foreground">{f.hint}</p>
                {invalid(f) ? <p className="text-xs text-destructive">{vi.adminSettings.invalid}</p> : null}
                {errors[f.key] ? <p className="text-xs text-destructive">{errors[f.key]}</p> : null}
              </div>
            ))}
            <Button type="submit" disabled={save.isPending || anyInvalid}>
              {save.isPending ? vi.common.loading : vi.adminSettings.save}
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
