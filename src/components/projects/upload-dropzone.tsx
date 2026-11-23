'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { AlertCircle, FileUp, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

const ACCEPT = '.txt,.md,.srt';

type Uploaded = { id: string };

/** Kéo thả hoặc bấm nút chọn tệp .txt/.md/.srt (Khung thông tin và upload kịch bản) */
export function UploadDropzone({
  projectId,
  onUploaded,
  className,
}: {
  projectId: string;
  onUploaded?: (fileId: string) => void;
  className?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return api<Uploaded>(`/api/projects/${projectId}/files`, { method: 'POST', body: form });
    },
    onSuccess: (f) => {
      setError(null);
      toast.success(t.files.uploaded);
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      onUploaded?.(f.id);
    },
    onError: (e) => {
      const msg = e instanceof ApiError ? (e.fields?.file ?? e.message) : t.common.genericError;
      setError(msg);
    },
  });

  function pick(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    if (!/\.(txt|md|srt)$/i.test(file.name)) {
      setError(t.files.acceptHint);
      return;
    }
    upload.mutate(file);
  }

  return (
    <div className={cn('space-y-2', className)}>
      <Card
        role="button"
        tabIndex={0}
        aria-label={t.files.dropHere}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={cn(
          'cursor-pointer border-2 border-dashed transition-all hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring',
          drag && 'border-primary bg-accent/60 shadow-inner',
          upload.isPending && 'pointer-events-none opacity-60',
        )}
      >
        <CardContent className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 sm:p-5">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {upload.isPending ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <FileUp className="size-5" />
              )}
            </div>
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">
                {upload.isPending ? t.files.uploading : t.files.dropHere}
              </p>
              <p className="text-xs text-muted-foreground line-clamp-2">{t.files.acceptHint}</p>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            disabled={upload.isPending}
            onClick={(e) => {
              e.stopPropagation();
              input.current?.click();
            }}
            className="shrink-0 gap-1.5 font-medium"
          >
            {upload.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t.files.selectFile}
          </Button>

          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="hidden"
            aria-label={t.files.uploadTitle}
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </CardContent>
      </Card>

      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive px-1">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
