'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';
import { cn } from '@/lib/utils';

const ACCEPT = '.txt,.md,.srt';

type Uploaded = { id: string };

/** Kéo thả hoặc chọn tệp .txt/.md/.srt; kiểm tra sơ bộ phía client, máy chủ vẫn là nơi quyết định cuối cùng. */
export function UploadDropzone({ projectId, onUploaded }: { projectId: string; onUploaded?: (fileId: string) => void }) {
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
    <div className="space-y-2">
      <div
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
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring',
          drag && 'border-primary bg-accent/50',
          upload.isPending && 'pointer-events-none opacity-60',
        )}
      >
        <Upload className="size-8 text-muted-foreground" />
        <p className="font-medium">{upload.isPending ? t.files.uploading : t.files.dropHere}</p>
        <p className="max-w-md text-xs text-muted-foreground">{t.files.acceptHint}</p>
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
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
