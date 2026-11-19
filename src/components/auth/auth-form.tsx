'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { vi } from '@/lib/i18n/vi';

type Mode = 'login' | 'register';

/** Chỉ cho phép chuyển hướng nội bộ (chống open redirect). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/projects';
}

function messageFor(status: number, code: string | undefined, mode: Mode): string {
  if (status === 429) return vi.auth.tooManyAttempts;
  if (status === 403) return vi.auth.accountDisabled;
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return vi.auth.emailTaken;
  if (mode === 'login') return vi.auth.invalidCredentials;
  return vi.common.genericError;
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLogin = mode === 'login';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(isLogin ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isLogin ? { email, password } : { email, password, name }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; error?: { message?: string } };
        // Lỗi chính sách (422) mang thông điệp tiếng Việt cụ thể từ máy chủ
        setError(res.status === 422 && body.message ? body.message : messageFor(res.status, body.code, mode));
        return;
      }
      router.replace(safeNext(params.get('next')));
      router.refresh();
    } catch {
      setError(vi.common.genericError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isLogin ? vi.auth.loginTitle : vi.auth.registerTitle}</CardTitle>
        <CardDescription>{isLogin ? vi.auth.loginSubtitle : vi.auth.registerSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {!isLogin ? (
            <div className="space-y-2">
              <Label htmlFor="name">{vi.auth.displayName}</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" required />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="email">{vi.auth.email}</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{vi.auth.password}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              required
            />
            {!isLogin ? <p className="text-xs text-muted-foreground">{vi.auth.passwordHint}</p> : null}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? vi.auth.submitting : isLogin ? vi.auth.submitLogin : vi.auth.submitRegister}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {isLogin ? vi.auth.noAccount : vi.auth.haveAccount}{' '}
            <Link href={isLogin ? '/register' : '/login'} className="font-medium text-foreground underline underline-offset-4">
              {isLogin ? vi.auth.goRegister : vi.auth.goLogin}
            </Link>
          </p>
          {isLogin ? <p className="text-center text-xs text-muted-foreground">{vi.auth.forgotPasswordInfo}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}
