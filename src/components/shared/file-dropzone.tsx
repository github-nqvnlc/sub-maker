'use client';

import { useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type Props = {
  /** `row`: một hàng ngang, cả khung bấm được. `stack`: xếp dọc, chỉ nút bấm được. */
  variant?: 'row' | 'stack';
  accept: string;
  /** Tên vùng kéo thả cho trình đọc màn hình */
  label: string;
  /** Tên ô chọn tệp cho trình đọc màn hình */
  inputLabel: string;
  title: string;
  hint: string;
  buttonLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  onPick: (file: File) => void;
  busy?: boolean;
  /** Đã chọn một tệp: nút chuyển sang kiểu phụ */
  hasFile?: boolean;
  /** Cắt tiêu đề dài trên một dòng (khi tiêu đề là tên tệp) */
  truncateTitle?: boolean;
  /** Nút cũng hiện vòng quay khi đang bận */
  spinButton?: boolean;
};

/** Ô kéo-thả hoặc bấm để chọn một tệp. Việc kiểm tra và tải lên do nơi dùng quyết định (máy chủ luôn kiểm tra lại). */
export function FileDropzone({
  variant = 'row',
  accept,
  label,
  inputLabel,
  title,
  hint,
  buttonLabel,
  icon: Icon,
  onPick,
  busy = false,
  hasFile = false,
  truncateTitle = false,
  spinButton = false,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const pick = (f: File | undefined | null) => {
    if (f) onPick(f);
  };
  const open = () => input.current?.click();
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(true);
    },
    onDragLeave: () => setDrag(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDrag(false);
      pick(e.dataTransfer.files[0]);
    },
  };
  const field = (
    <input
      ref={input}
      type="file"
      accept={accept}
      className={variant === 'row' ? 'hidden' : 'sr-only'}
      aria-label={inputLabel}
      onChange={(e) => {
        pick(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );

  if (variant === 'stack') {
    return (
      <div
        tabIndex={0}
        role="region"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        {...dropProps}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          drag ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/40',
          hasFile ? 'bg-muted/30' : '',
        )}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-6" />
        </div>
        <div className="space-y-1">
          <p className={cn('text-sm font-medium', truncateTitle && 'truncate')}>{title}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{hint}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={open}>
          {buttonLabel}
        </Button>
        {field}
      </div>
    );
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={open}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open()}
      {...dropProps}
      className={cn(
        'cursor-pointer border-2 border-dashed transition-all hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring',
        drag && 'border-primary bg-accent/60 shadow-inner',
        busy && 'pointer-events-none opacity-60',
      )}
    >
      <CardContent className="flex flex-col items-center justify-between gap-4 p-4 sm:flex-row sm:p-5">
        <div className="flex min-w-0 items-center gap-3.5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
          </div>
          <div className="min-w-0 space-y-0.5">
            <p className={cn('text-sm font-medium', truncateTitle && 'truncate')}>{title}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={hasFile ? 'outline' : 'default'}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
          className="shrink-0 gap-1.5 font-medium"
        >
          {busy && spinButton ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {buttonLabel}
        </Button>
        {field}
      </CardContent>
    </Card>
  );
}
