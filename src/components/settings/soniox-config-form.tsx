'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api, apiDelete, apiPost, apiPut } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n/client';

export type SttConfig = {
  baseUrl: string;
  apiKeyHint: string;
  defaultModel: string;
  enableDiarization: boolean;
  pricePerAudioHourUsd: number | null;
  enabled: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
};
type TestResult = { ok: boolean; message: string; latencyMs: number };

const DEFAULT_BASE_URL = 'https://api.soniox.com';
const CUSTOM = '__custom__';
/** Danh mục model Soniox (trang Models, 2026-11-23); real-time chỉ hiển thị, không chọn được làm mặc định (FR-010). */
const MODELS: Array<{ id: string; kind: 'async' | 'realtime'; legacy?: boolean; recommended?: boolean }> = [
  { id: 'stt-async-v6', kind: 'async', recommended: true },
  { id: 'stt-async-v5', kind: 'async', legacy: true },
  { id: 'stt-rt-v6', kind: 'realtime' },
];

export const useSttConfig = () => useQuery({ queryKey: ['stt-config'], queryFn: () => api<SttConfig | null>('/api/admin/stt-config') });

/** Tab SONIOX của Cấu hình AI chung (spec 004, US4): một token cho mọi model STT. */
export function SonioxConfigPanel() {
  const t = useT();
  const q = useSttConfig();
  if (q.isPending) return <LoadingList rows={3} />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  const c = q.data;
  return <SonioxConfigForm key={`${c?.baseUrl ?? ''}:${c?.apiKeyHint ?? ''}:${c?.enabled ?? ''}:${c?.defaultModel ?? ''}`} config={c} title={t.providersAdmin.sonioxTab} />;
}

function SonioxConfigForm({ config, title }: { config: SttConfig | null; title: string }) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const known = MODELS.some((m) => m.id === config?.defaultModel);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [modelChoice, setModelChoice] = useState(config ? (known ? config.defaultModel : CUSTOM) : 'stt-async-v6');
  const [customModel, setCustomModel] = useState(config && !known ? config.defaultModel : '');
  const [price, setPrice] = useState(config?.pricePerAudioHourUsd != null ? String(config.pricePerAudioHourUsd) : '');
  const [diarization, setDiarization] = useState(config?.enableDiarization ?? false);
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['stt-config'] });

  const save = useMutation({
    mutationFn: () =>
      apiPut<SttConfig>('/api/admin/stt-config', {
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        defaultModel: modelChoice === CUSTOM ? customModel.trim() : modelChoice,
        pricePerAudioHourUsd: price.trim() === '' ? null : Number(price),
        enableDiarization: diarization,
        enabled,
      }),
    onSuccess: () => {
      setErrors({});
      setApiKey('');
      toast.success(t.aiConfig.saved);
      void refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : t.common.genericError);
    },
  });

  const test = useMutation({
    mutationFn: () => apiPost<TestResult>('/api/admin/stt-config/test'),
    onSuccess: (r) => {
      setTestResult(r);
      void refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t.common.genericError),
  });

  const field = (name: string) => (errors[name] ? <p className="text-sm text-destructive">{errors[name]}</p> : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{t.providersAdmin.sonioxDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="soniox-baseUrl">{t.aiConfig.baseUrl}</Label>
            <Input id="soniox-baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t.aiConfig.baseUrlHint}</p>
            {field('baseUrl')}
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="soniox-apiKey">{t.aiConfig.apiKey}</Label>
            <Input id="soniox-apiKey" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={config ? t.aiConfig.apiKeyKeep : ''} />
            {config ? (
              <p className="text-xs text-muted-foreground">
                {t.aiConfig.apiKeyHintLabel}: <code>{config.apiKeyHint}</code>
              </p>
            ) : null}
            {field('apiKey')}
          </div>

          <div className="space-y-2">
            <Label>{t.providersAdmin.sonioxModel}</Label>
            <Select value={modelChoice} onValueChange={setModelChoice}>
              <SelectTrigger className="w-full" aria-label={t.providersAdmin.sonioxModel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id} disabled={m.kind === 'realtime'}>
                    {m.id}
                    {m.recommended ? ` ${t.providersAdmin.sonioxModelRecommended}` : ''}
                    {m.legacy ? ` — ${t.providersAdmin.sonioxModelLegacy}` : ''}
                    {m.kind === 'realtime' ? ` — ${t.providersAdmin.sonioxModelRealtime}` : ''}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM}>{t.providersAdmin.sonioxModelCustom}</SelectItem>
              </SelectContent>
            </Select>
            {modelChoice === CUSTOM ? <Input value={customModel} onChange={(e) => setCustomModel(e.target.value)} className="mt-1.5" aria-label={t.providersAdmin.sonioxModelCustom} /> : null}
            {field('defaultModel')}
          </div>

          <div className="space-y-2">
            <Label htmlFor="soniox-price">{t.providersAdmin.sonioxPrice}</Label>
            <Input id="soniox-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t.aiConfig.priceHint}</p>
            {field('pricePerAudioHourUsd')}
          </div>

          <div className="flex items-center gap-2 md:col-span-2">
            <Switch id="soniox-diarization" checked={diarization} onCheckedChange={setDiarization} />
            <Label htmlFor="soniox-diarization">{t.providersAdmin.sonioxDiarization}</Label>
          </div>

          <div className="flex items-center gap-2 md:col-span-2">
            <Switch id="soniox-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="soniox-enabled">{t.aiConfig.enabled}</Label>
          </div>

          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t.common.loading : t.aiConfig.save}
            </Button>
            {config ? (
              <>
                <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? t.aiConfig.testing : t.aiConfig.test}
                </Button>
                <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
                  {t.aiConfig.delete}
                </Button>
              </>
            ) : null}
          </div>

          {testResult ? (
            <Alert className="md:col-span-2" variant={testResult.ok ? 'default' : 'destructive'}>
              <AlertDescription>
                <strong>{testResult.ok ? t.aiConfig.testOk : t.aiConfig.testFail}</strong> — {testResult.message} ({testResult.latencyMs} ms)
              </AlertDescription>
            </Alert>
          ) : config?.lastTestAt ? (
            <p className="text-xs text-muted-foreground md:col-span-2">
              {t.aiConfig.lastTest}: {fx.dateTime(config.lastTestAt)} — {config.lastTestOk ? t.aiConfig.testOk : t.aiConfig.testFail}
            </p>
          ) : null}
        </form>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t.aiConfig.deleteTitle}
          description={<p>{t.aiConfig.deleteDesc}</p>}
          confirmLabel={t.aiConfig.delete}
          onConfirm={async () => {
            await apiDelete('/api/admin/stt-config');
            toast.success(t.aiConfig.deleted);
            await refresh();
          }}
        />
      </CardContent>
    </Card>
  );
}
