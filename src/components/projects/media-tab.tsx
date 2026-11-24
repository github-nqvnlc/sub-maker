'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Download, Eye, FileAudio, Import, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api } from '@/lib/api-client';
import { fmtBytes } from '@/lib/format';
import { useSttJobs, type SttJobDto } from '@/lib/hooks/use-stt-jobs';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';
import { cn } from '@/lib/utils';

const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
const VIDEO = ['mp4', 'mov', 'mkv', 'webm'];
const ACCEPT = [...AUDIO, ...VIDEO].map((e) => `.${e}`).join(',');
const MB = 1024 * 1024;
const LANGS = ['vi', 'en', 'zh', 'ja', 'ko', 'fr'] as const;
const AUTO = 'auto';

function checkFile(t: Dict, f: File): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  if (!AUDIO.includes(ext) && !VIDEO.includes(ext)) return t.stt.badType;
  if (f.size > (VIDEO.includes(ext) ? 500 : 100) * MB) return t.stt.tooLarge;
  return null;
}

export function MediaTab({
  projectId,
  onGoToJobs,
  onPreviewSubtitle,
  onImportToScript,
}: {
  projectId: string;
  onGoToJobs: () => void;
  onPreviewSubtitle: (fileId: string) => void;
  onImportToScript: (fileId: string) => void;
}) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'srt' | 'txt' | 'md'>('srt');
  const [language, setLanguage] = useState<string>(AUTO);
  const [diarization, setDiarization] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jobs = useSttJobs(projectId);
  const completedJobs = (jobs.data ?? []).filter((j) => j.status === 'completed' && j.resultSubtitleFileId);

  const start = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('file', file!);
      form.set('targetFormat', format);
      if (name.trim()) form.set('targetFileName', name.trim());
      form.set('language', language);
      form.set('enableDiarization', String(diarization));
      return api<SttJobDto>(`/api/projects/${projectId}/stt`, { method: 'POST', body: form });
    },
    onSuccess: () => {
      toast.success(t.stt.started);
      setFile(null);
      setName('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['stt-jobs', projectId] });
      void qc.invalidateQueries({ queryKey: ['project', projectId] });
      // Tự động chuyển sang tab Tiến trình để theo dõi
      onGoToJobs();
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e.fields ? Object.values(e.fields).join('. ') : e.message);
      else setError(t.common.genericError);
    },
  });

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    const problem = checkFile(t, f);
    setError(problem);
    setFile(problem ? null : f);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Cột trái: Form tạo subtitle từ Audio / Video */}
        <div className="space-y-4 lg:col-span-7 xl:col-span-7">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">{t.projects.mediaTabTitle}</h2>
            <p className="text-xs text-muted-foreground">{t.projects.mediaTabDesc}</p>
          </div>

          <Card>
            <CardContent className="space-y-4 p-5">
              {/* Dropzone */}
              <div
                tabIndex={0}
                role="region"
                aria-label={t.stt.dropHint}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  pickFile(e.dataTransfer.files[0]);
                }}
                className={cn(
                  'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
                  drag ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/40',
                  file ? 'bg-muted/30' : '',
                )}
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  {file ? <FileAudio className="size-6" /> : <Upload className="size-6" />}
                </div>
                <div className="space-y-1">
                  <p className="truncate text-sm font-medium">{file ? `${file.name} (${fmtBytes(file.size)})` : t.stt.dropHint}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{t.stt.formatsHint}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  {file ? t.stt.changeFile : t.stt.chooseFile}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  aria-label={t.stt.chooseFile}
                  onChange={(e) => {
                    pickFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>

              {/* Tên kịch bản */}
              <div className="space-y-2">
                <Label htmlFor="media-stt-name">{t.stt.fileName}</Label>
                <Input
                  id="media-stt-name"
                  value={name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={file?.name.replace(/\.[^.]+$/, '') ?? ''}
                />
                <p className="text-xs text-muted-foreground">{t.stt.fileNameHint}</p>
              </div>

              {/* Định dạng đầu ra & Ngôn ngữ */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t.stt.format}</Label>
                  <Select value={format} onValueChange={(v: 'srt' | 'txt' | 'md') => setFormat(v)}>
                    <SelectTrigger className='w-full' aria-label={t.stt.format}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="srt">{t.stt.formatSrt}</SelectItem>
                      <SelectItem value="txt">{t.stt.formatTxt}</SelectItem>
                      <SelectItem value="md">{t.stt.formatMd}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>{t.stt.language}</Label>
                  <Select value={language} onValueChange={setLanguage}>
                    <SelectTrigger className='w-full' aria-label={t.stt.language}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO}>{t.stt.languageAuto}</SelectItem>
                      {LANGS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {t.stt.languages[l]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t.stt.languageHint}</p>
                </div>
              </div>

              {/* Tách người nói */}
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="media-stt-diarization" className="text-sm font-medium">
                    {t.stt.diarization}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t.stt.diarizationHint}</p>
                </div>
                <Switch id="media-stt-diarization" checked={diarization} onCheckedChange={setDiarization} />
              </div>

              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="flex justify-end pt-2">
                <Button disabled={!file || start.isPending} onClick={() => start.mutate()}>
                  {start.isPending ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      {t.stt.starting}
                    </>
                  ) : (
                    t.stt.start
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Cột phải: Danh sách phụ đề đã tạo từ Video & Audio */}
        <div className="space-y-3 lg:col-span-5 xl:col-span-5">
          <div className="flex items-center justify-between pb-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{t.projects.mediaListTitle}</h2>
              <Badge variant="secondary">{completedJobs.length}</Badge>
            </div>
          </div>

          {jobs.isPending ? (
            <LoadingList rows={3} />
          ) : jobs.isError ? (
            <ErrorState message={t.stt.loadError} onRetry={() => void jobs.refetch()} />
          ) : completedJobs.length === 0 ? (
            <EmptyState title={t.projects.mediaListEmpty} />
          ) : (
            <ul className="space-y-2.5 max-h-[820px] overflow-y-auto pr-1">
              {completedJobs.map((j) => (
                <li key={j.id} className="p-1">
                  <Card className="transition-colors hover:border-muted-foreground/40">
                    <CardContent className="flex flex-col gap-3 p-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="truncate text-left text-sm font-medium hover:underline text-foreground"
                            onClick={() => j.resultSubtitleFileId && onPreviewSubtitle(j.resultSubtitleFileId)}
                          >
                            {j.targetFileName}
                          </button>
                          <Badge variant="outline">.{j.targetFormat}</Badge>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="capitalize">{j.mediaType}</span>
                          <span>{fx.dateTime(j.createdAt)}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 pt-1 border-t">
                        {j.resultSubtitleFileId ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 gap-1.5 px-2.5 text-xs"
                              onClick={() => onPreviewSubtitle(j.resultSubtitleFileId!)}
                            >
                              <Eye className="size-3.5" />
                              {t.files.preview}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 gap-1.5 px-2.5 text-xs asChild"
                              asChild
                            >
                              <a href={`/api/files/${j.resultSubtitleFileId}/download`} download>
                                <Download className="size-3.5" />
                                {t.files.download}
                              </a>
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-8 gap-1.5 px-2.5 text-xs ml-auto"
                              onClick={() => onImportToScript(j.resultSubtitleFileId!)}
                            >
                              <Import className="size-3.5" />
                              {t.projects.loadToScript}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
