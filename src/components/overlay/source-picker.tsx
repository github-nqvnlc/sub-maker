'use client';

import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { FileAudio, FileUp, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FileDropzone } from '@/components/shared/file-dropzone';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useOverlayAudioActions, type OverlayAudioDto, type OverlaySource } from '@/lib/hooks/use-overlay';
import { fmt } from '@/lib/i18n/fmt';
import { useFormat, useT } from '@/lib/i18n/client';

export type SourceFile = { id: string; originalName: string; ext: string; hasTimecodes?: boolean; createdAt: string };
export type SourceVoice = { id: string; title: string; fileId?: string; durationMs: number; createdAt: string };

const AUDIO_EXTS = ['mp3', 'wav', 'm4a'];
const AUDIO_ACCEPT = AUDIO_EXTS.map((e) => `.${e}`).join(',');
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/** Chỉ kịch bản .srt có mốc thời gian mới làm phụ đề được (FR-003). */
export const isUsable = (f: SourceFile): boolean => f.ext === 'srt' && !!f.hasTimecodes;

const errorText = (e: unknown, fallback: string): string => (e instanceof ApiError ? (e.fields?.file ?? e.message) : fallback);

/** Chọn voice và phụ đề, hoặc tải tệp từ máy (FR-002, FR-003, FR-042). */
export function SourcePicker({
  projectId,
  source,
  onChange,
  voices,
  files,
  audios,
}: {
  projectId: string;
  source: OverlaySource;
  onChange: (s: OverlaySource) => void;
  voices: readonly SourceVoice[];
  files: readonly SourceFile[];
  audios: UseQueryResult<OverlayAudioDto[]>;
}) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const [audioError, setAudioError] = useState<string | null>(null);
  const [srtError, setSrtError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<OverlayAudioDto | null>(null);
  const { upload, remove } = useOverlayAudioActions(projectId);

  const uploadSrt = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set('file', file);
      return api<{ id: string; hasTimecodes?: boolean }>(`/api/projects/${projectId}/files`, { method: 'POST', body: form });
    },
    onSuccess: async (f) => {
      await qc.invalidateQueries({ queryKey: ['project', projectId] });
      if (!f.hasTimecodes) {
        setSrtError(t.overlay.srtNoTimecodes);
        return;
      }
      toast.success(t.overlay.srtUploaded);
      onChange({ ...source, fileId: f.id });
    },
    onError: (e) => setSrtError(errorText(e, t.common.genericError)),
  });

  function pickAudio(f: File) {
    const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
    const problem = !AUDIO_EXTS.includes(ext) ? t.overlay.audioBadType : f.size > MAX_AUDIO_BYTES ? t.overlay.audioTooLarge : null;
    setAudioError(problem);
    if (problem) return;
    upload.mutate(f, {
      onSuccess: (a) => {
        toast.success(t.overlay.uploadStarted);
        onChange({ ...source, voiceId: null, audioId: a.id });
      },
      onError: (e) => setAudioError(errorText(e, t.common.genericError)),
    });
  }

  function pickSrt(f: File) {
    const problem = /\.srt$/i.test(f.name) ? null : t.overlay.srtBadType;
    setSrtError(problem);
    if (!problem) uploadSrt.mutate(f);
  }

  function pickVoice(value: string) {
    const [kind, id = ''] = value.split(':');
    if (kind === 'audio') {
      onChange({ ...source, voiceId: null, audioId: id });
      return;
    }
    // Voice của hệ thống: chọn luôn đúng tệp đã tạo ra nó nếu dùng được
    const own = files.find((f) => f.id === voices.find((v) => v.id === id)?.fileId);
    onChange({ voiceId: id, audioId: null, fileId: own && isUsable(own) ? own.id : source.fileId });
  }

  const audioList = audios.data ?? [];
  const voiceValue = source.voiceId ? `voice:${source.voiceId}` : source.audioId ? `audio:${source.audioId}` : '';

  return (
    <section className="space-y-3" aria-labelledby="overlay-source-title">
      <h2 id="overlay-source-title" className="text-base font-semibold">
        {t.overlay.sourceTitle}
      </h2>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label>{t.overlay.voice}</Label>
              <Select value={voiceValue} onValueChange={pickVoice} disabled={voices.length === 0 && audioList.length === 0}>
                <SelectTrigger className="w-full" aria-label={t.overlay.voice}>
                  <SelectValue placeholder={t.overlay.voicePlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {voices.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{t.overlay.voiceGroup}</SelectLabel>
                      {voices.map((v) => (
                        <SelectItem key={v.id} value={`voice:${v.id}`}>
                          {v.title} ({fmtDuration(v.durationMs)})
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  {audioList.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>{t.overlay.audioGroup}</SelectLabel>
                      {audioList.map((a) => (
                        <SelectItem key={a.id} value={`audio:${a.id}`} disabled={a.status !== 'ready'}>
                          {a.originalName} ({a.status === 'ready' && a.durationMs ? fmtDuration(a.durationMs) : t.overlay.audioStatus[a.status]})
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-2">
              <Label>{t.overlay.subtitle}</Label>
              <Select value={source.fileId ?? ''} onValueChange={(fileId) => onChange({ ...source, fileId })} disabled={files.length === 0}>
                <SelectTrigger className="w-full" aria-label={t.overlay.subtitle}>
                  <SelectValue placeholder={t.overlay.subtitlePlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {files.map((f) => (
                    <SelectItem key={f.id} value={f.id} disabled={!isUsable(f)}>
                      {isUsable(f) ? f.originalName : `${f.originalName} (${t.overlay.subtitleUnusable})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t.overlay.subtitleHint}</p>
            </div>
          </div>

          <Separator />
          <div className="space-y-2">
            <FileDropzone
              accept={AUDIO_ACCEPT}
              label={t.overlay.uploadAudio}
              inputLabel={t.overlay.uploadAudio}
              title={upload.isPending ? t.overlay.uploading : t.overlay.uploadAudio}
              hint={t.overlay.uploadAudioHint}
              buttonLabel={t.overlay.chooseFile}
              icon={FileAudio}
              busy={upload.isPending}
              onPick={pickAudio}
            />
            {audioError ? (
              <p role="alert" className="text-sm text-destructive">
                {audioError}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <FileDropzone
              accept=".srt"
              label={t.overlay.uploadSrt}
              inputLabel={t.overlay.uploadSrt}
              title={uploadSrt.isPending ? t.overlay.uploading : t.overlay.uploadSrt}
              hint={t.overlay.uploadSrtHint}
              buttonLabel={t.overlay.chooseFile}
              icon={FileUp}
              busy={uploadSrt.isPending}
              onPick={pickSrt}
            />
            {srtError ? (
              <p role="alert" className="text-sm text-destructive">
                {srtError}
              </p>
            ) : null}
          </div>

          {audios.isPending ? <LoadingList rows={1} /> : null}
          {audios.isError ? <ErrorState message={audios.error.message} onRetry={() => void audios.refetch()} /> : null}
          {audioList.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{t.overlay.audioListTitle}</h3>
                <Badge variant="secondary">{audioList.length}</Badge>
              </div>
              <ul className="divide-y rounded-lg border">
                {audioList.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 p-3" data-testid="overlay-audio-item">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate font-medium" title={a.originalName}>
                          {a.originalName}
                        </span>
                        <Badge variant={a.status === 'failed' ? 'destructive' : a.status === 'ready' ? 'secondary' : 'outline'}>{t.overlay.audioStatus[a.status]}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {a.status === 'ready' ? `${fmtDuration(a.durationMs ?? 0)} · ${fmtBytes(a.sizeBytes)} · ` : null}
                        {fx.dateTime(a.createdAt)}
                      </p>
                      {a.status === 'failed' ? (
                        <p role="alert" className="text-xs text-destructive">
                          {(t.overlay.errors as Record<string, string>)[a.errorCode ?? 'INTERNAL'] ?? t.overlay.errors.INTERNAL}
                        </p>
                      ) : null}
                    </div>
                    <Button size="icon" variant="ghost" aria-label={`${t.overlay.delete}: ${a.originalName}`} onClick={() => setToDelete(a)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={t.overlay.deleteAudioTitle}
        description={
          <>
            <p className="font-medium text-foreground">{fmt(t.overlay.deleteAudioCount, { n: 1, size: fmtBytes(toDelete?.sizeBytes ?? 0) })}</p>
            <p className="break-all">{toDelete?.originalName}</p>
            <p>{t.overlay.deleteAudioDesc}</p>
          </>
        }
        confirmLabel={t.overlay.delete}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await remove.mutateAsync([toDelete.id]);
            toast.success(t.overlay.audioDeleted);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : t.common.genericError);
          }
        }}
      />
    </section>
  );
}
