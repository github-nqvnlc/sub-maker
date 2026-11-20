'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { ApiError, apiPost } from '@/lib/api-client';
import { useProviders } from '@/lib/hooks/use-providers';
import { useT } from '@/lib/i18n/client';
import { EstimatePanel, useEstimate } from '@/components/jobs/estimate-panel';
import { TimingOptions } from '@/components/jobs/timing-options';

export type StartableFile = { id: string; originalName: string; segmentCount: number; charCount: number; hasTimecodes?: boolean };

type Props = {
  projectId: string;
  providerType: string;
  files: StartableFile[];
  /** Tệp được chọn sẵn; đặt giá trị để mở hộp thoại, null để đóng */
  openFileId: string | null;
  onClose: () => void;
};

/** Chọn tệp kịch bản + model + giọng + tốc độ rồi bắt đầu tạo voice (FR-012). */
export function StartJobDialog({ projectId, providerType, files, openFileId, onClose }: Props) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const providers = useProviders();
  const provider = providers.data?.find((p) => p.type === providerType);

  const [fileId, setFileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [timedPick, setTimedPick] = useState<boolean | null>(null);
  const [mergeCues, setMergeCues] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Giá trị hiệu lực: lựa chọn của người dùng, nếu chưa chọn thì mặc định theo catalog (suy ra khi render)
  const effFile = fileId ?? openFileId ?? files[0]?.id ?? '';
  const effModel = model ?? provider?.models[0]?.id ?? '';
  const modelInfo = provider?.models.find((m) => m.id === effModel);
  const effVoice = voice && modelInfo?.voices.some((v) => v.id === voice) ? voice : (modelInfo?.voices[0]?.id ?? '');
  const effSpeed = speed ?? provider?.speed.default ?? 1;
  // Chế độ khớp mốc: bật sẵn khi tệp có mốc thời gian hợp lệ (spec 003, FR-003)
  const fileInfo = files.find((f) => f.id === effFile);
  const timingAvailable = !!fileInfo?.hasTimecodes;
  const effTimed = timingAvailable && (timedPick ?? true);
  const timing = effTimed ? ({ mode: 'timed', mergeCues } as const) : undefined;
  const estimate = useEstimate(effFile, { model: effModel || null, voice: effVoice, speed: effSpeed, ...(timing ? { timing } : {}) }, !!openFileId && !!provider?.available);
  const quotaBlocked = estimate.data?.quotaOk === false;

  const start = useMutation({
    mutationFn: () => apiPost<{ id: string }>(`/api/projects/${projectId}/jobs`, { fileId: effFile, model: effModel, voice: effVoice, speed: effSpeed, ...(timing ? { timing } : {}) }),
    onSuccess: (job) => {
      toast.success(t.jobs.started);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
      router.push(`/projects/${projectId}/jobs/${job.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e.fields ? Object.values(e.fields).join('. ') : e.message);
      else setError(t.common.genericError);
    },
  });

  return (
    <Dialog
      open={!!openFileId}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          setFileId(null);
          setTimedPick(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.jobs.startTitle}</DialogTitle>
          <DialogDescription>{t.jobs.startDesc}</DialogDescription>
        </DialogHeader>

        {!provider ? (
          <p className="text-sm text-muted-foreground">{t.common.loading}</p>
        ) : (
          <div className="space-y-4">
            {!provider.available ? (
              <Alert variant="destructive">
                <AlertDescription>{t.projects.noProviderTip}</AlertDescription>
              </Alert>
            ) : (
              <p className="text-xs text-muted-foreground">{provider.usingOwnConfig ? t.jobs.usingOwn : t.jobs.usingGlobal}</p>
            )}

            {files.length > 1 ? (
              <div className="space-y-2">
                <Label>{t.jobs.file}</Label>
                <Select value={effFile} onValueChange={setFileId}>
                  <SelectTrigger aria-label={t.jobs.file}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {files.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.originalName} ({f.segmentCount} {t.files.segments})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

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
                <Label htmlFor="speed">{t.jobs.speed}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{effSpeed}</span>
              </div>
              <Slider
                id="speed"
                min={provider.speed.min}
                max={provider.speed.max}
                step={provider.speed.step}
                value={[effSpeed]}
                onValueChange={([v]) => setSpeed(v ?? null)}
                aria-label={t.jobs.speed}
              />
            </div>

            <TimingOptions
              idPrefix="start"
              value={{ timed: timedPick ?? true, mergeCues }}
              available={timingAvailable}
              onChange={(v) => {
                setTimedPick(v.timed);
                setMergeCues(v.mergeCues);
              }}
            />

            {provider.available ? <EstimatePanel query={estimate} /> : null}

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
          <Button disabled={start.isPending || !provider?.available || !effFile || !effVoice || quotaBlocked} onClick={() => start.mutate()}>
            {start.isPending ? t.common.loading : t.jobs.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
