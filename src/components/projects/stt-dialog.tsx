'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, FileAudio, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { EventLog } from '@/components/shared/event-log';
import { FileDropzone } from '@/components/shared/file-dropzone';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { ApiError, api } from '@/lib/api-client';
import { fmtBytes } from '@/lib/format';
import { STT_ACTIVE, useSttJob, useSttJobs, type SttJobDto, type SttLogDto, type SttStatus } from '@/lib/hooks/use-stt-jobs';
import { fmt } from '@/lib/i18n/fmt';
import { useFormat, useT } from '@/lib/i18n/client';
import type { Dict } from '@/lib/i18n/types';
import { cn } from '@/lib/utils';

const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
const VIDEO = ['mp4', 'mov', 'mkv', 'webm'];
const ACCEPT = [...AUDIO, ...VIDEO].map((e) => `.${e}`).join(',');
const MB = 1024 * 1024;
const LANGS = ['vi', 'en', 'zh', 'ja', 'ko', 'fr'] as const;
const AUTO = 'auto';

/** Kiểm tra phía trình duyệt (máy chủ vẫn kiểm tra lại): định dạng và dung lượng (FR-001). */
function checkFile(t: Dict, f: File): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  if (!AUDIO.includes(ext) && !VIDEO.includes(ext)) return t.stt.badType;
  if (f.size > (VIDEO.includes(ext) ? 500 : 100) * MB) return t.stt.tooLarge;
  return null;
}

/** Cùng cách tô màu với huy hiệu trạng thái tiến trình tạo voice (components/jobs/status-badge). */
const STATUS_STYLE: Record<SttStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  extracting: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  uploading: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  transcribing: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  formatting: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-destructive/15 text-destructive',
  interrupted: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};

function SttStatusBadge({ status }: { status: SttStatus }) {
  const t = useT();
  const running = STT_ACTIVE.has(status) && status !== 'queued';
  return (
    <Badge variant="outline" className={cn('border-transparent font-medium', STATUS_STYLE[status])}>
      {running ? <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-current" aria-hidden /> : null}
      {t.stt.status[status]}
    </Badge>
  );
}

function renderLog(t: Dict, l: SttLogDto): string {
  const tpl = (t.stt.log as Record<string, string>)[l.messageKey] ?? l.messageKey;
  const params = { ...(l.params ?? {}) };
  if (l.messageKey === 'failed' && typeof params.reason === 'string') {
    params.reason = (t.stt.errors as Record<string, string>)[params.reason] ?? params.reason;
  }
  return fmt(tpl, params);
}

function SttLog({ jobId }: { jobId: string }) {
  const t = useT();
  const q = useSttJob(jobId);
  if (q.isPending) return <LoadingList rows={2} />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  return (
    <EventLog label={t.stt.showLog} empty={t.stt.logEmpty} entries={q.data.logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, text: renderLog(t, l) }))} />
  );
}

function SttJobItem({ job, onOpenResult }: { job: SttJobDto; onOpenResult?: (fileId: string) => void }) {
  const t = useT();
  const fx = useFormat();
  const active = STT_ACTIVE.has(job.status);
  const [showLog, setShowLog] = useState(active);
  const error = job.errorCode ? ((t.stt.errors as Record<string, string>)[job.errorCode] ?? job.errorMessage) : null;
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium" title={job.originalFileName}>
          {job.originalFileName}
        </span>
        <Badge variant="outline">.{job.targetFormat}</Badge>
        <SttStatusBadge status={job.status} />
      </div>
      {active ? <Progress value={job.progressPercent} className="h-1.5" aria-label={t.stt.status[job.status]} /> : null}
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{fx.dateTime(job.createdAt)}</span>
        <div className="ml-auto flex gap-2">
          {job.resultSubtitleFileId && onOpenResult ? (
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => onOpenResult(job.resultSubtitleFileId!)}>
              {t.stt.openResult}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
            {showLog ? t.stt.hideLog : t.stt.showLog}
          </Button>
        </div>
      </div>
      {showLog ? <SttLog jobId={job.id} /> : null}
    </li>
  );
}

/** Danh sách tiến trình phiên âm của Project: đang tải / lỗi / rỗng / danh sách (Hiến pháp VI). */
export function SttJobList({ projectId, onOpenResult }: { projectId: string; onOpenResult?: (fileId: string) => void }) {
  const t = useT();
  const jobs = useSttJobs(projectId);
  if (jobs.isPending) return <LoadingList rows={2} />;
  if (jobs.isError) return <ErrorState message={t.stt.loadError} onRetry={() => void jobs.refetch()} />;
  if (jobs.data.length === 0) return <p className="text-sm text-muted-foreground">{t.stt.jobsEmpty}</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {jobs.data.map((j) => (
        <SttJobItem key={j.id} job={j} onOpenResult={onOpenResult} />
      ))}
    </ul>
  );
}

/**
 * Tạo phụ đề từ audio/video bằng Soniox (spec 004, US1–US3): chọn tệp, tên, định dạng, ngôn ngữ gợi ý, phân biệt người nói;
 * theo dõi tiến độ và nhật ký. Đóng hộp thoại không dừng tiến trình (chạy nền).
 */
export function SttDialog({
  projectId,
  open,
  onOpenChange,
  onOpenResult,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenResult?: (fileId: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'srt' | 'txt' | 'md'>('srt');
  const [language, setLanguage] = useState<string>(AUTO);
  const [diarization, setDiarization] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jobs = useSttJobs(projectId);
  // Khi một job vừa hoàn tất: làm mới Project để tệp kết quả xuất hiện ngay trong danh sách kịch bản (US1-AS5)
  const completed = jobs.data?.filter((j) => j.status === 'completed').length ?? 0;
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (seen.current !== null && completed > seen.current) void qc.invalidateQueries({ queryKey: ['project', projectId] });
    seen.current = completed;
  }, [completed, projectId, qc]);

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
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e.fields ? Object.values(e.fields).join('. ') : e.message);
      else setError(t.common.genericError);
    },
  });

  function pick(f: File) {
    const problem = checkFile(t, f);
    setError(problem);
    setFile(problem ? null : f);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.stt.title}</DialogTitle>
          <DialogDescription>{t.stt.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FileDropzone
            accept={ACCEPT}
            label={t.stt.dropHint}
            inputLabel={t.stt.chooseFile}
            title={file ? `${file.name} (${fmtBytes(file.size)})` : t.stt.dropHint}
            hint={t.stt.formatsHint}
            buttonLabel={file ? t.stt.changeFile : t.stt.chooseFile}
            icon={FileAudio}
            busy={start.isPending}
            hasFile={!!file}
            truncateTitle
            onPick={pick}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="stt-name">{t.stt.fileName}</Label>
              <Input id="stt-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={file?.name.replace(/\.[^.]+$/, '') ?? ''} />
              <p className="text-xs text-muted-foreground">{t.stt.fileNameHint}</p>
            </div>

            <div className="space-y-2">
              <Label>{t.stt.format}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
                <SelectTrigger className="w-full" aria-label={t.stt.format}>
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
                <SelectTrigger className="w-full" aria-label={t.stt.language}>
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

            <div className="space-y-1 sm:col-span-2">
              <div className="flex items-center gap-2">
                <Switch id="stt-diarization" checked={diarization} onCheckedChange={setDiarization} />
                <Label htmlFor="stt-diarization">{t.stt.diarization}</Label>
              </div>
              <p className="text-xs text-muted-foreground">{t.stt.diarizationHint}</p>
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.stt.close}
          </Button>
          <Button disabled={!file || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? t.stt.starting : t.stt.start}
          </Button>
        </DialogFooter>

        <div className="space-y-2 border-t pt-4">
          <h3 className="text-base font-semibold">{t.stt.jobsTitle}</h3>
          <p className="text-xs text-muted-foreground">{t.stt.keepRunning}</p>
          <SttJobList projectId={projectId} onOpenResult={onOpenResult} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Banner nhỏ trên trang Project khi còn tiến trình phiên âm chạy nền (US3): mở lại hộp thoại để xem tiến độ. */
export function SttActiveBanner({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const t = useT();
  const jobs = useSttJobs(projectId);
  const active = jobs.data?.filter((j) => STT_ACTIVE.has(j.status)) ?? [];
  if (active.length === 0) return null;
  const avg = Math.round(active.reduce((s, j) => s + j.progressPercent, 0) / active.length);
  return (
    <Card role="status" aria-live="polite">
      <CardContent className="flex flex-wrap items-center gap-3 p-3">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        <span className="text-sm font-medium">{fmt(t.stt.banner, { count: active.length })}</span>
        <Progress value={avg} className="h-1.5 min-w-24 flex-1" aria-label={t.stt.jobsTitle} />
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={onOpen}>
          {t.stt.bannerOpen}
        </Button>
      </CardContent>
    </Card>
  );
}
