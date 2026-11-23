'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost, apiPut } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';
import { UserAssignmentPicker, type PickedUser } from '@/components/settings/user-assignment-picker';

export type AccessMode = 'public' | 'restricted' | 'private';
export type CustomProviderDto = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyHint: string;
  models: string[];
  defaultModel: string | null;
  defaultVoice: string | null;
  accessMode: AccessMode;
  assignedUserIds: string[];
  assignedUsers: PickedUser[];
  enabled: boolean;
  pricePerMillionChars: number | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
};

/** Thêm/sửa Custom Provider chuẩn OpenAI kèm phạm vi sử dụng (spec 004, US5-AS1). `provider = undefined` để đóng. */
export function CustomProviderDialog({ provider, onClose }: { provider: CustomProviderDto | null | undefined; onClose: () => void }) {
  return (
    <Dialog open={provider !== undefined} onOpenChange={(o) => !o && onClose()}>
      {provider !== undefined ? <CustomProviderForm key={provider?.id ?? 'new'} provider={provider} onClose={onClose} /> : null}
    </Dialog>
  );
}

function CustomProviderForm({ provider, onClose }: { provider: CustomProviderDto | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? 'https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState((provider?.models ?? ['tts-1']).join('\n'));
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? '');
  const [defaultVoice, setDefaultVoice] = useState(provider?.defaultVoice ?? '');
  const [access, setAccess] = useState<AccessMode>(provider?.accessMode ?? 'private');
  const [users, setUsers] = useState<PickedUser[]>(provider?.assignedUsers ?? []);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [price, setPrice] = useState(provider?.pricePerMillionChars != null ? String(provider.pricePerMillionChars) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: models.split('\n').map((m) => m.trim()).filter(Boolean),
        defaultModel: defaultModel.trim() || null,
        defaultVoice: defaultVoice.trim() || null,
        accessMode: access,
        assignedUserIds: access === 'restricted' ? users.map((u) => u.id) : [],
        enabled,
        pricePerMillionChars: price.trim() === '' ? null : Number(price),
      };
      return provider ? apiPut(`/api/admin/custom-ai-providers/${provider.id}`, body) : apiPost('/api/admin/custom-ai-providers', body);
    },
    onSuccess: () => {
      toast.success(t.providersAdmin.saved);
      void qc.invalidateQueries({ queryKey: ['custom-ai-providers'] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : t.common.genericError);
    },
  });

  const field = (k: string) => (errors[k] ? <p className="text-sm text-destructive">{errors[k]}</p> : null);
  const accessHint = { public: t.providersAdmin.accessPublicHint, restricted: t.providersAdmin.accessRestrictedHint, private: t.providersAdmin.accessPrivateHint }[access];

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{provider ? t.providersAdmin.editProvider : t.providersAdmin.addProvider}</DialogTitle>
        <DialogDescription>{t.providersAdmin.customDescription}</DialogDescription>
      </DialogHeader>
      <form
        id="custom-provider-form"
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="cp-name">{t.providersAdmin.name}</Label>
          <Input id="cp-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          {field('name')}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="cp-baseUrl">{t.aiConfig.baseUrl}</Label>
          <Input id="cp-baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t.aiConfig.baseUrlHint}</p>
          {field('baseUrl')}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="cp-apiKey">{t.aiConfig.apiKey}</Label>
          <Input id="cp-apiKey" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider ? t.aiConfig.apiKeyKeep : ''} />
          {provider ? (
            <p className="text-xs text-muted-foreground">
              {t.aiConfig.apiKeyHintLabel}: <code>{provider.apiKeyHint}</code>
            </p>
          ) : null}
          {field('apiKey')}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="cp-models">{t.providersAdmin.models}</Label>
          <Textarea id="cp-models" rows={3} value={models} onChange={(e) => setModels(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t.providersAdmin.modelsHint}</p>
          {field('models')}
        </div>
        <div className="space-y-2">
          <Label htmlFor="cp-model">{t.aiConfig.defaultModel}</Label>
          <Input id="cp-model" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder={t.aiConfig.customModelPlaceholder} />
          {field('defaultModel')}
        </div>
        <div className="space-y-2">
          <Label htmlFor="cp-voice">{t.aiConfig.defaultVoice}</Label>
          <Input id="cp-voice" value={defaultVoice} onChange={(e) => setDefaultVoice(e.target.value)} placeholder={t.aiConfig.customVoicePlaceholder} />
          {field('defaultVoice')}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label>{t.providersAdmin.access}</Label>
          <Select value={access} onValueChange={(v) => setAccess(v as AccessMode)}>
            <SelectTrigger aria-label={t.providersAdmin.access}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">{t.providersAdmin.accessPublic}</SelectItem>
              <SelectItem value="restricted">{t.providersAdmin.accessRestricted}</SelectItem>
              <SelectItem value="private">{t.providersAdmin.accessPrivate}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{accessHint}</p>
          {access === 'restricted' ? <UserAssignmentPicker value={users} onChange={setUsers} /> : null}
          {field('assignedUserIds')}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="cp-price">{t.aiConfig.price}</Label>
          <Input id="cp-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t.aiConfig.priceHint}</p>
          {field('pricePerMillionChars')}
        </div>
        <div className="flex items-center gap-2 md:col-span-2">
          <Switch id="cp-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="cp-enabled">{t.aiConfig.enabled}</Label>
        </div>
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button type="submit" form="custom-provider-form" disabled={save.isPending || !name.trim()}>
          {save.isPending ? t.common.loading : t.aiConfig.save}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
