'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { ApiError, api, apiPost } from '@/lib/api-client';
import { useProviders } from '@/lib/hooks/use-providers';
import { useT } from '@/lib/i18n/client';
import { EstimatePanel, useEstimate } from '@/components/jobs/estimate-panel';
import { TimingOptions } from '@/components/jobs/timing-options';
import { VoicePreviewButton } from '@/components/jobs/voice-preview-button';

export type StartableFile = { id: string; originalName: string; segmentCount: number; charCount: number; hasTimecodes?: boolean };

type Props = {
  projectId: string;
  providerType?: string;
  files: StartableFile[];
  /** Tệp được chọn sẵn; đặt giá trị để mở hộp thoại, null để đóng */
  openFileId: string | null;
  onClose: () => void;
};

/** Chọn nhà cung cấp AI + tệp kịch bản + model + giọng + tốc độ rồi bắt đầu tạo voice (FR-012, is-04). */
export function StartJobDialog({ projectId, providerType, files, openFileId, onClose }: Props) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const providers = useProviders();

  const ttsProviders = providers.data ?? [];
  const initialProvider =
    providerType
      ? providerType === 'shopaikey_openai'
        ? 'shopaikey_minimax'
        : providerType
      : (ttsProviders.find((p) => p.available)?.type ?? ttsProviders[0]?.type ?? 'fpt_marketplace');

  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const effProviderType = selectedProvider ?? initialProvider;
  const provider = ttsProviders.find((p) => p.type === effProviderType) ?? providers.data?.find((p) => p.type === effProviderType);

  const [fileId, setFileId] = useState<string | null>(null);
  const [customId, setCustomId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [language, setLanguage] = useState<'auto' | 'vi' | 'en'>('auto');
  const [manualVoice, setManualVoice] = useState(false);
  const [customVoiceId, setCustomVoiceId] = useState('');
  const [timedPick, setTimedPick] = useState<boolean | null>(null);
  const [mergeCues, setMergeCues] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dynamic voices cho Soniox (bao gồm cả voice tạo trên Console)
  const sonioxVoicesQuery = useQuery({
    queryKey: ['soniox-voices'],
    queryFn: () => api<Array<{ id: string; label: string; isCustom?: boolean }>>('/api/providers/soniox/voices'),
    enabled: effProviderType === 'soniox',
  });

  // Spec 004: Project chuẩn OpenAI không có cấu hình riêng → chọn một Custom Provider do Administrator cấp quyền
  const customs = effProviderType === 'openai_compatible' && !provider?.usingOwnConfig ? (provider?.customProviders ?? []) : [];
  const custom = customs.find((c) => c.id === customId) ?? customs[0];
  const modelOptions = custom && custom.models.length > 0 ? custom.models.map((id) => ({ id, label: id })) : (provider?.models ?? []);

  // Giá trị hiệu lực: lựa chọn của người dùng, nếu chưa chọn thì mặc định theo catalog (suy ra khi render)
  const effFile = fileId ?? openFileId ?? files[0]?.id ?? '';
  const effModel = model ?? custom?.defaultModel ?? modelOptions[0]?.id ?? '';
  // Giọng chuẩn OpenAI giống nhau ở mọi model; model ngoài danh mục dùng danh sách giọng của model đầu
  const modelInfo = provider?.models.find((m) => m.id === effModel) ?? (custom ? provider?.models[0] : undefined);
  const customVoice = custom?.defaultVoice && modelInfo?.voices.some((v) => v.id === custom.defaultVoice) ? custom.defaultVoice : null;

  const sonioxVoices = sonioxVoicesQuery.data ?? [];
  const voiceChoices =
    effProviderType === 'soniox' && sonioxVoices.length > 0
      ? sonioxVoices.map((v) => ({ id: v.id, label: v.label }))
      : (modelInfo?.voices ?? []);

  const effVoice = manualVoice && customVoiceId.trim()
    ? customVoiceId.trim()
    : voice && voiceChoices.some((v) => v.id === voice)
      ? voice
      : (customVoice ?? voiceChoices[0]?.id ?? '');

  const effSpeed = speed ?? provider?.speed.default ?? 1;
  // Chế độ khớp mốc: bật sẵn khi tệp có mốc thời gian hợp lệ (spec 003, FR-003)
  const fileInfo = files.find((f) => f.id === effFile);
  const timingAvailable = !!fileInfo?.hasTimecodes;
  const effTimed = timingAvailable && (timedPick ?? true);
  const timing = effTimed ? ({ mode: 'timed', mergeCues } as const) : undefined;
  const customBody = custom ? { customProviderId: custom.id } : {};
  const langParam = language !== 'auto' ? { language } : {};

  const estimate = useEstimate(
    effFile,
    { providerType: effProviderType, model: effModel || null, voice: effVoice, speed: effSpeed, ...langParam, ...customBody, ...(timing ? { timing } : {}) },
    !!openFileId && !!provider?.available,
  );
  const quotaBlocked = estimate.data?.quotaOk === false;

  const start = useMutation({
    mutationFn: () =>
      apiPost<{ id: string }>(`/api/projects/${projectId}/jobs`, {
        fileId: effFile,
        providerType: effProviderType,
        model: effModel,
        voice: effVoice,
        speed: effSpeed,
        ...langParam,
        ...customBody,
        ...(timing ? { timing } : {}),
      }),
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
          setCustomId(null);
          setTimedPick(null);
          setSelectedProvider(null);
          setManualVoice(false);
          setCustomVoiceId('');
          setLanguage('auto');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.jobs.startTitle}</DialogTitle>
          <DialogDescription>{t.jobs.startDesc}</DialogDescription>
        </DialogHeader>

        {!provider ? (
          <p className="text-sm text-muted-foreground">{t.common.loading}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t.projects.provider}</Label>
              <Select
                value={effProviderType}
                onValueChange={(v) => {
                  setSelectedProvider(v);
                  setModel(null);
                  setVoice(null);
                  setCustomId(null);
                  setManualVoice(false);
                  setCustomVoiceId('');
                }}
              >
                <SelectTrigger className='w-full' aria-label={t.projects.provider}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ttsProviders.map((p) => (
                    <SelectItem key={p.type} value={p.type}>
                      {p.label}
                      {!p.available ? ` (${t.projects.providerUnavailable})` : p.usingOwnConfig ? ` (${t.projects.providerOwn})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
                  <SelectTrigger className='w-full' aria-label={t.jobs.file}>
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

            {customs.length > 0 ? (
              <div className="space-y-2">
                <Label>{t.providersAdmin.customProviderLabel}</Label>
                <Select
                  value={custom?.id ?? ''}
                  onValueChange={(v) => {
                    setCustomId(v);
                    setModel(null);
                    setVoice(null);
                  }}
                >
                  <SelectTrigger className='w-full' aria-label={t.providersAdmin.customProviderLabel}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {customs.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {modelOptions.length > 1 ? (
              <div className="space-y-2">
                <Label>{t.jobs.model}</Label>
                <Select
                  value={effModel}
                  onValueChange={(v) => {
                    setModel(v);
                    setVoice(null);
                  }}
                >
                  <SelectTrigger className='w-full' aria-label={t.jobs.model}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label || m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {/* Ngôn ngữ đọc (đặc thù Soniox hoặc đa ngôn ngữ) */}
            {effProviderType === 'soniox' ? (
              <div className="space-y-2">
                <Label>{t.jobs.language}</Label>
                <Select value={language} onValueChange={(v: 'auto' | 'vi' | 'en') => setLanguage(v)}>
                  <SelectTrigger className='w-full' aria-label={t.jobs.language}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t.jobs.languageAuto}</SelectItem>
                    <SelectItem value="vi">{t.jobs.languageVi}</SelectItem>
                    <SelectItem value="en">{t.jobs.languageEn}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t.jobs.voice}</Label>
                {effProviderType === 'soniox' ? (
                  <button
                    type="button"
                    onClick={() => setManualVoice(!manualVoice)}
                    className="text-xs text-primary hover:underline cursor-pointer"
                  >
                    {manualVoice ? t.jobs.toggleListVoice : t.jobs.toggleCustomVoice}
                  </button>
                ) : null}
              </div>

              {manualVoice ? (
                <div className="space-y-1">
                  <Input
                    value={customVoiceId}
                    onChange={(e) => setCustomVoiceId(e.target.value)}
                    placeholder={t.jobs.customVoicePlaceholder}
                    aria-label={t.jobs.customVoiceInput}
                  />
                  <p className="text-xs text-muted-foreground">{t.jobs.customVoiceInput}</p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Select value={effVoice} onValueChange={setVoice}>
                      <SelectTrigger className='w-full' aria-label={t.jobs.voice}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {voiceChoices.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <VoicePreviewButton providerType={effProviderType} voiceId={effVoice} />
                </div>
              )}
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

