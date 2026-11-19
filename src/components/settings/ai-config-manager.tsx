'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api, apiDelete, apiPost, apiPut } from '@/lib/api-client';
import { vi } from '@/lib/i18n/vi';

type Voice = { id: string; label: string };
type CatalogItem = {
  type: string;
  label: string;
  models: { id: string; voices: Voice[] }[];
  speed: { min: number; max: number; default: number; step: number };
  maxCharsPerRequest: number;
};
type AiConfig = {
  scope: 'global' | 'user';
  type: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string;
  defaultModel: string | null;
  defaultVoice: string | null;
  defaultSpeed: number | null;
  maxCharsPerRequest: number;
  pricePerMillionChars: number | null;
  enabled: boolean;
  disabledReason: 'owner_removed_from_list' | 'admin_disabled' | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
};
type TestResult = { ok: boolean; message: string; latencyMs: number };

const NONE = '__none__';
const DEFAULT_BASE_URL: Record<string, string> = {
  fpt_marketplace: 'https://mkp-api.fptcloud.com/v1',
  shopaikey_openai: 'https://api.shopaikey.com',
  shopaikey_minimax: 'https://api.shopaikey.com',
};

/** Quản lý cấu hình nhà cung cấp AI: dùng chung cho Administrator (cấu hình chung) và User được phép (cấu hình riêng). */
export function AiConfigManager({ scope }: { scope: 'admin' | 'user' }) {
  const base = scope === 'admin' ? '/api/admin/ai-configs' : '/api/me/ai-config';
  const catalog = useQuery({ queryKey: ['providers'], queryFn: () => api<CatalogItem[]>('/api/providers') });
  const configs = useQuery({ queryKey: ['ai-configs', scope], queryFn: () => api<AiConfig[]>(base) });

  if (catalog.isPending || configs.isPending) return <LoadingList rows={3} />;
  if (catalog.isError || configs.isError) {
    return <ErrorState message={(catalog.error ?? configs.error)?.message} onRetry={() => void Promise.all([catalog.refetch(), configs.refetch()])} />;
  }
  const byType = new Map(configs.data.map((c) => [c.type, c]));
  const anyEnabled = configs.data.some((c) => c.enabled);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{scope === 'admin' ? vi.aiConfig.adminTitle : vi.aiConfig.userTitle}</h1>
        <p className="text-sm text-muted-foreground">{scope === 'admin' ? vi.aiConfig.adminDescription : vi.aiConfig.userDescription}</p>
      </div>
      {scope === 'admin' && !anyEnabled ? (
        <Alert variant="destructive">
          <AlertDescription>{vi.aiConfig.noGlobalWarning}</AlertDescription>
        </Alert>
      ) : null}
      <Tabs defaultValue={catalog.data[0]?.type} aria-label={vi.aiConfig.tabs}>
        <TabsList className="flex h-auto flex-wrap">
          {catalog.data.map((c) => {
            const cfg = byType.get(c.type);
            return (
              <TabsTrigger key={c.type} value={c.type} className="gap-2">
                {c.label}
                <Badge variant={cfg ? (cfg.enabled ? 'default' : 'secondary') : 'outline'} className="text-[10px]">
                  {cfg ? (cfg.enabled ? vi.aiConfig.configured : vi.aiConfig.disabled) : vi.aiConfig.notConfigured}
                </Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {catalog.data.map((c) => (
          <TabsContent key={c.type} value={c.type}>
            {/* key theo dấu vân tay dữ liệu để biểu mẫu nạp lại giá trị khi cấu hình thay đổi */}
            <ProviderConfigForm
              key={`${c.type}:${byType.get(c.type)?.baseUrl ?? ''}:${byType.get(c.type)?.apiKeyHint ?? ''}:${byType.get(c.type)?.enabled ?? ''}`}
              scope={scope}
              base={base}
              catalog={c}
              config={byType.get(c.type) ?? null}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ProviderConfigForm({ scope, base, catalog, config }: { scope: 'admin' | 'user'; base: string; catalog: CatalogItem; config: AiConfig | null }) {
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? DEFAULT_BASE_URL[catalog.type] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config?.defaultModel ?? NONE);
  const [voice, setVoice] = useState(config?.defaultVoice ?? NONE);
  const [speed, setSpeed] = useState(config?.defaultSpeed != null ? String(config.defaultSpeed) : '');
  const [maxChars, setMaxChars] = useState(String(config?.maxCharsPerRequest ?? catalog.maxCharsPerRequest));
  const [price, setPrice] = useState(config?.pricePerMillionChars != null ? String(config.pricePerMillionChars) : '');
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const voices = (catalog.models.find((m) => m.id === model)?.voices ?? catalog.models.flatMap((m) => m.voices)).filter(
    (v, i, arr) => arr.findIndex((x) => x.id === v.id) === i,
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ['ai-configs', scope] });
  const num = (s: string) => (s.trim() === '' ? null : Number(s));

  const save = useMutation({
    mutationFn: () =>
      apiPut<AiConfig>(base, {
        type: catalog.type,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        defaultModel: model === NONE ? null : model,
        defaultVoice: voice === NONE ? null : voice,
        defaultSpeed: num(speed),
        maxCharsPerRequest: Number(maxChars),
        pricePerMillionChars: num(price),
        enabled,
      }),
    onSuccess: () => {
      setErrors({});
      setApiKey('');
      toast.success(vi.aiConfig.saved);
      void refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : vi.common.genericError);
    },
  });

  const test = useMutation({
    mutationFn: () => apiPost<TestResult>(`${base}/${catalog.type}/test`),
    onSuccess: (r) => {
      setTestResult(r);
      void refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : vi.common.genericError),
  });

  const field = (name: string) => (errors[name] ? <p className="text-sm text-destructive">{errors[name]}</p> : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{catalog.label}</CardTitle>
        {config?.disabledReason === 'owner_removed_from_list' ? (
          <CardDescription className="text-destructive">{vi.aiConfig.ownerRemoved}</CardDescription>
        ) : null}
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
            <Label htmlFor={`${catalog.type}-baseUrl`}>{vi.aiConfig.baseUrl}</Label>
            <Input id={`${catalog.type}-baseUrl`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">{vi.aiConfig.baseUrlHint}</p>
            {field('baseUrl')}
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor={`${catalog.type}-apiKey`}>{vi.aiConfig.apiKey}</Label>
            <Input
              id={`${catalog.type}-apiKey`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config ? vi.aiConfig.apiKeyKeep : ''}
            />
            {config ? (
              <p className="text-xs text-muted-foreground">
                {vi.aiConfig.apiKeyHintLabel}: <code>{config.apiKeyHint}</code>
              </p>
            ) : null}
            {field('apiKey')}
          </div>

          <div className="space-y-2">
            <Label>{vi.aiConfig.defaultModel}</Label>
            <Select
              value={model}
              onValueChange={(v) => {
                setModel(v);
                setVoice(NONE);
              }}
            >
              <SelectTrigger aria-label={vi.aiConfig.defaultModel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{vi.aiConfig.none}</SelectItem>
                {catalog.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {field('defaultModel')}
          </div>

          <div className="space-y-2">
            <Label>{vi.aiConfig.defaultVoice}</Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger aria-label={vi.aiConfig.defaultVoice}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{vi.aiConfig.none}</SelectItem>
                {voices.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {field('defaultVoice')}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${catalog.type}-speed`}>
              {vi.aiConfig.defaultSpeed} ({catalog.speed.min} – {catalog.speed.max})
            </Label>
            <Input id={`${catalog.type}-speed`} inputMode="decimal" value={speed} onChange={(e) => setSpeed(e.target.value)} />
            {field('defaultSpeed')}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${catalog.type}-maxChars`}>{vi.aiConfig.maxChars}</Label>
            <Input id={`${catalog.type}-maxChars`} inputMode="numeric" value={maxChars} onChange={(e) => setMaxChars(e.target.value)} />
            {field('maxCharsPerRequest')}
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor={`${catalog.type}-price`}>{vi.aiConfig.price}</Label>
            <Input id={`${catalog.type}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <p className="text-xs text-muted-foreground">{vi.aiConfig.priceHint}</p>
            {field('pricePerMillionChars')}
          </div>

          <div className="flex items-center gap-2 md:col-span-2">
            <Switch id={`${catalog.type}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor={`${catalog.type}-enabled`}>{vi.aiConfig.enabled}</Label>
          </div>

          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? vi.common.loading : vi.aiConfig.save}
            </Button>
            {config ? (
              <>
                <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? vi.aiConfig.testing : vi.aiConfig.test}
                </Button>
                <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
                  {vi.aiConfig.delete}
                </Button>
              </>
            ) : null}
          </div>

          {testResult ? (
            <Alert className="md:col-span-2" variant={testResult.ok ? 'default' : 'destructive'}>
              <AlertDescription>
                <strong>{testResult.ok ? vi.aiConfig.testOk : vi.aiConfig.testFail}</strong> — {testResult.message} ({testResult.latencyMs} ms)
              </AlertDescription>
            </Alert>
          ) : config?.lastTestAt ? (
            <p className="text-xs text-muted-foreground md:col-span-2">
              {vi.aiConfig.lastTest}: {new Date(config.lastTestAt).toLocaleString('vi-VN')} — {config.lastTestOk ? vi.aiConfig.testOk : vi.aiConfig.testFail}
            </p>
          ) : null}
        </form>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={vi.aiConfig.deleteTitle}
          description={<p>{vi.aiConfig.deleteDesc}</p>}
          confirmLabel={vi.aiConfig.delete}
          onConfirm={async () => {
            await apiDelete(`${base}/${catalog.type}`);
            toast.success(vi.aiConfig.deleted);
            await refresh();
          }}
        />
      </CardContent>
    </Card>
  );
}
