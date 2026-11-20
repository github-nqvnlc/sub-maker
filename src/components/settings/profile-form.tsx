'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api, apiDelete, apiPatch } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';

type Me = {
  displayName: string;
  bio: string | null;
  hasAvatar: boolean;
  email: string;
  storageUsedBytes: number;
  storageQuotaBytes: number;
};

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

export function ProfileForm() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') });
  if (me.isPending) return <LoadingList rows={3} />;
  if (me.isError) return <ErrorState message={me.error.message} onRetry={() => void me.refetch()} />;
  // Giá trị ban đầu của biểu mẫu lấy từ dữ liệu đã tải; không đồng bộ lại bằng effect để tránh ghi đè khi đang gõ.
  return <ProfileFields data={me.data} />;
}

function ProfileFields({ data }: { data: Me }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(data.displayName);
  const [bio, setBio] = useState(data.bio ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [avatarVersion, setAvatarVersion] = useState(0);

  const save = useMutation({
    mutationFn: () => apiPatch<Me>('/api/me', { displayName: name, bio }),
    onSuccess: () => {
      setFieldErrors({});
      toast.success(t.profile.saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
      router.refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setFieldErrors(e.fields);
      else toast.error(e instanceof Error ? e.message : t.common.genericError);
    },
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return api('/api/me/avatar', { method: 'PUT', body: form });
    },
    onSuccess: () => {
      toast.success(t.profile.avatarSaved);
      setAvatarVersion((v) => v + 1);
      void qc.invalidateQueries({ queryKey: ['me'] });
      router.refresh();
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? (e.fields?.file ?? e.message) : t.common.genericError;
      toast.error(msg);
    },
  });

  const remove = useMutation({
    mutationFn: () => apiDelete('/api/me/avatar'),
    onSuccess: () => {
      toast.success(t.profile.avatarRemoved);
      void qc.invalidateQueries({ queryKey: ['me'] });
      router.refresh();
    },
  });

  const pct = Math.min(100, Math.round((data.storageUsedBytes / data.storageQuotaBytes) * 100));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t.profile.title}</CardTitle>
          <CardDescription>{t.profile.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-4">
            <Avatar className="size-16">
              {data.hasAvatar ? <AvatarImage src={`/api/me/avatar?v=${avatarVersion}`} alt="" /> : null}
              <AvatarFallback className="text-lg">{([...data.displayName.trim()][0] ?? '?').toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
                  {t.profile.chooseAvatar}
                </Button>
                {data.hasAvatar ? (
                  <Button type="button" variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                    {t.profile.removeAvatar}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{t.profile.avatarHint}</p>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                aria-label={t.profile.avatar}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="displayName">{t.profile.displayName}</Label>
              <Input id="displayName" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              {fieldErrors.displayName ? <p className="text-sm text-destructive">{fieldErrors.displayName}</p> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="bio">{t.profile.bio}</Label>
              <Textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} rows={4} placeholder={t.profile.bioPlaceholder} />
              {fieldErrors.bio ? <p className="text-sm text-destructive">{fieldErrors.bio}</p> : null}
            </div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t.common.loading : t.common.save}
            </Button>
          </form>

          <div className="space-y-2 border-t pt-4">
            <div className="flex justify-between text-sm">
              <span>{t.profile.storage}</span>
              <span className="text-muted-foreground">
                {mb(data.storageUsedBytes)} / {mb(data.storageQuotaBytes)}
              </span>
            </div>
            <Progress value={pct} />
          </div>
        </CardContent>
      </Card>

      <PasswordForm />
    </div>
  );
}

function PasswordForm() {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const change = useMutation({
    mutationFn: () => api('/api/me/password', { method: 'POST', json: { currentPassword: current, newPassword: next } }),
    onSuccess: () => {
      setErrors({});
      setCurrent('');
      setNext('');
      toast.success(t.profile.passwordChanged);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      else toast.error(t.common.genericError);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.profile.passwordTitle}</CardTitle>
        <CardDescription>{t.auth.passwordHint}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="currentPassword">{t.profile.currentPassword}</Label>
            <Input id="currentPassword" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            {errors.currentPassword ? <p className="text-sm text-destructive">{errors.currentPassword}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">{t.profile.newPassword}</Label>
            <Input id="newPassword" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {errors.newPassword ? <p className="text-sm text-destructive">{errors.newPassword}</p> : null}
          </div>
          <Button type="submit" disabled={change.isPending || !current || !next}>
            {t.profile.changePassword}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
