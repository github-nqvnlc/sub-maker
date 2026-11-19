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
import { vi } from '@/lib/i18n/vi';

export type StartableFile = { id: string; originalName: string; segmentCount: number; charCount: number };

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
  const router = useRouter();
  const qc = useQueryClient();
  const providers = useProviders();
  const provider = providers.data?.find((p) => p.type === providerType);

  const [fileId, setFileId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Giá trị hiệu lực: lựa chọn của người dùng, nếu chưa chọn thì mặc định theo catalog (suy ra khi render)
  const effFile = fileId ?? openFileId ?? files[0]?.id ?? '';
  const effModel = model ?? provider?.models[0]?.id ?? '';
  const modelInfo = provider?.models.find((m) => m.id === effModel);
  const effVoice = voice && modelInfo?.voices.some((v) => v.id === voice) ? voice : (modelInfo?.voices[0]?.id ?? '');
  const effSpeed = speed ?? provider?.speed.default ?? 1;

  const start = useMutation({
    mutationFn: () => apiPost<{ id: string }>(`/api/projects/${projectId}/jobs`, { fileId: effFile, model: effModel, voice: effVoice, speed: effSpeed }),
    onSuccess: (job) => {
      toast.success(vi.jobs.started);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      onClose();
      router.push(`/projects/${projectId}/jobs/${job.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e.fields ? Object.values(e.fields).join('. ') : e.message);
      else setError(vi.common.genericError);
    },
  });

  return (
    <Dialog
      open={!!openFileId}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          setFileId(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{vi.jobs.startTitle}</DialogTitle>
          <DialogDescription>{vi.jobs.startDesc}</DialogDescription>
        </DialogHeader>

        {!provider ? (
          <p className="text-sm text-muted-foreground">{vi.common.loading}</p>
        ) : (
          <div className="space-y-4">
            {!provider.available ? (
              <Alert variant="destructive">
                <AlertDescription>{vi.projects.noProviderTip}</AlertDescription>
              </Alert>
            ) : (
              <p className="text-xs text-muted-foreground">{provider.usingOwnConfig ? vi.jobs.usingOwn : vi.jobs.usingGlobal}</p>
            )}

            {files.length > 1 ? (
              <div className="space-y-2">
                <Label>{vi.jobs.file}</Label>
                <Select value={effFile} onValueChange={setFileId}>
                  <SelectTrigger aria-label={vi.jobs.file}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {files.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.originalName} ({f.segmentCount} {vi.files.segments})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {provider.models.length > 1 ? (
              <div className="space-y-2">
                <Label>{vi.jobs.model}</Label>
                <Select
                  value={effModel}
                  onValueChange={(v) => {
                    setModel(v);
                    setVoice(null);
                  }}
                >
                  <SelectTrigger aria-label={vi.jobs.model}>
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
              <Label>{vi.jobs.voice}</Label>
              <Select value={effVoice} onValueChange={setVoice}>
                <SelectTrigger aria-label={vi.jobs.voice}>
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
                <Label htmlFor="speed">{vi.jobs.speed}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{effSpeed}</span>
              </div>
              <Slider
                id="speed"
                min={provider.speed.min}
                max={provider.speed.max}
                step={provider.speed.step}
                value={[effSpeed]}
                onValueChange={([v]) => setSpeed(v ?? null)}
                aria-label={vi.jobs.speed}
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {vi.common.cancel}
          </Button>
          <Button disabled={start.isPending || !provider?.available || !effFile || !effVoice} onClick={() => start.mutate()}>
            {start.isPending ? vi.common.loading : vi.jobs.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
