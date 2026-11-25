'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertCircle, FileUp } from 'lucide-react';
import { toast } from 'sonner';
import { FileDropzone } from '@/components/shared/file-dropzone';
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

  function pick(file: File) {
    setError(null);
    if (!/\.(txt|md|srt)$/i.test(file.name)) {
      setError(t.files.acceptHint);
      return;
    }
    upload.mutate(file);
  }

  return (
    <div className={cn('space-y-2', className)}>
      <FileDropzone
        accept={ACCEPT}
        label={t.files.dropHere}
        inputLabel={t.files.uploadTitle}
        title={upload.isPending ? t.files.uploading : t.files.dropHere}
        hint={t.files.acceptHint}
        buttonLabel={t.files.selectFile}
        icon={FileUp}
        busy={upload.isPending}
        spinButton
        onPick={pick}
      />

      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive px-1">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
