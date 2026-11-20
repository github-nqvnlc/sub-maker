'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { ApiError, apiPatch, apiPost } from '@/lib/api-client';
import { useProviders } from '@/lib/hooks/use-providers';
import { useT } from '@/lib/i18n/client';
import { TimingOptions } from '@/components/jobs/timing-options';

export type EditableJob = {
  id: string;
  projectId: string;
  settings: { model: string | null; voice: string; speed: number | null; timing?: { mode: 'timed'; mergeCues: boolean } | null };
};

type Props = {
  job: EditableJob | null;
  providerType: string;
  /** `edit`: sửa tiến trình đã dừng/lỗi (PATCH). `rerun`: tạo tiến trình mới với thiết lập tùy chọn (POST). */
  mode: 'edit' | 'rerun';
  onClose: () => void;
};

export function EditSettingsDialog({ job, providerType, mode, onClose }: Props) {
  return job ? <Form key={`${job.id}:${mode}`} job={job} providerType={providerType} mode={mode} onClose={onClose} /> : null;
}

function Form({ job, providerType, mode, onClose }: Props & { job: EditableJob }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const provider = useProviders().data?.find((p) => p.type === providerType);
  const [model, setModel] = useState<string | null>(job.settings.model);
  const [voice, setVoice] = useState<string | null>(job.settings.voice);
  const [speed, setSpeed] = useState<number | null>(job.settings.speed);
  // Chỉ job đang ở chế độ khớp mốc mới đổi được chế độ ở đây (job đọc liên tục: tạo voice mới để dùng khớp mốc)
  const wasTimed = !!job.settings.timing;
  const [timed, setTimed] = useState(wasTimed);
  const [mergeCues, setMergeCues] = useState(job.settings.timing?.mergeCues ?? true);
  const [error, setError] = useState<string | null>(null);

  const effModel = model ?? provider?.models[0]?.id ?? '';
  const modelInfo = provider?.models.find((m) => m.id === effModel);
  const effVoice = voice && modelInfo?.voices.some((v) => v.id === voice) ? voice : (modelInfo?.voices[0]?.id ?? '');
  const effSpeed = speed ?? provider?.speed.default ?? 1;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        model: effModel || null,
        voice: effVoice,
        speed: effSpeed,
        ...(wasTimed ? { timing: timed ? { mode: 'timed' as const, mergeCues } : { mode: 'continuous' as const } } : {}),
      };
      return mode === 'edit'
        ? apiPatch(`/api/jobs/${job.id}`, body)
        : apiPost<{ id: string }>(`/api/jobs/${job.id}/rerun`, body);
    },
    onSuccess: (res) => {
      toast.success(mode === 'edit' ? t.jobs.settingsSaved : t.jobs.rerunStarted);
      void qc.invalidateQueries({ queryKey: ['project', job.projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['job', job.id] });
      void qc.invalidateQueries({ queryKey: ['active-jobs'] });
      onClose();
      if (mode === 'rerun' && res && typeof res === 'object' && 'id' in res) {
        router.push(`/projects/${job.projectId}/jobs/${(res as { id: string }).id}`);
      }
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e.fields ? Object.values(e.fields).join('. ') : e.message);
      else setError(t.common.genericError);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? t.jobs.settingsTitle : t.jobs.rerunTitle}</DialogTitle>
          <DialogDescription>{mode === 'edit' ? t.jobs.settingsDesc : t.jobs.rerunDesc}</DialogDescription>
        </DialogHeader>
        {!provider ? (
          <p className="text-sm text-muted-foreground">{t.common.loading}</p>
        ) : (
          <div className="space-y-4">
            {provider.models.length > 1 ? (
              <div className="space-y-2">
                <Label>{t.jobs.model}</Label>
                <Select
                  value={effModel}
                  onValueChange={(v) => {
                    setModel(v);
                    setVoice(null);
                  }}
                >
                  <SelectTrigger aria-label={t.jobs.model}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {provider.models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>{t.jobs.voice}</Label>
              <Select value={effVoice} onValueChange={setVoice}>
                <SelectTrigger aria-label={t.jobs.voice}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(modelInfo?.voices ?? []).map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <Label htmlFor="job-speed">{t.jobs.speed}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{effSpeed}</span>
              </div>
              <Slider
                id="job-speed"
                min={provider.speed.min}
                max={provider.speed.max}
                step={provider.speed.step}
                value={[effSpeed]}
                onValueChange={([v]) => setSpeed(v ?? null)}
                aria-label={t.jobs.speed}
              />
            </div>
            {wasTimed ? <TimingOptions idPrefix="edit" value={{ timed, mergeCues }} available onChange={(v) => { setTimed(v.timed); setMergeCues(v.mergeCues); }} /> : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button disabled={save.isPending || !provider || !effVoice} onClick={() => save.mutate()}>
            {save.isPending ? t.common.loading : mode === 'edit' ? t.jobs.save : t.jobs.rerun}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
