'use client';

import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { vi } from '@/lib/i18n/vi';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Nêu rõ số lượng và hậu quả (Nguyên tắc VI). */
  description: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** Bắt buộc gõ lại chuỗi này mới cho xác nhận (ví dụ email khi xóa User). */
  requireText?: string;
  requireTextLabel?: string;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = vi.common.confirm,
  destructive = true,
  requireText,
  requireTextLabel,
  onConfirm,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const blocked = requireText ? typed.trim().toLowerCase() !== requireText.trim().toLowerCase() : false;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) {
          setTyped('');
          onOpenChange(o);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {requireText ? (
          <div className="space-y-2">
            {requireTextLabel ? <p className="text-sm">{requireTextLabel}</p> : null}
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{vi.common.cancel}</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || blocked}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                setTyped('');
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? vi.common.loading : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
