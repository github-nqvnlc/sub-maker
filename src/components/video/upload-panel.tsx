'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FileVideo, Loader2, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { SelectField } from '@/components/overlay/fields';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FileDropzone } from '@/components/shared/file-dropzone';
import { ApiError, api, apiDelete, apiPost } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useLiveUpload, useUploadVersion, videoKeys, type VideoJobDto, type VideoTabDto } from '@/lib/hooks/use-video';
import { useFormat, useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import { fingerprintFile } from '@/lib/video/fingerprint';
import { DIRECTIONS, VIDEO_EXTENSIONS, type Direction } from '@/lib/video/types';
import { rememberLocalVideo, uploadRegistry, VideoUpload } from '@/lib/video/upload-client';

const ACCEPT = VIDEO_EXTENSIONS.map((e) => `.${e}`).join(',');
const extensionOk = (name: string): boolean => (VIDEO_EXTENSIONS as readonly string[]).includes(/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '');
const errorText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
const receivedPercent = (job: VideoJobDto): number => (job.upload ? Math.floor((job.upload.receivedBytes / Math.max(1, job.upload.sizeBytes)) * 100) : 0);

type UploadStateResponse = { id: string; partSize: number; partCount: number; parts: number[] };

function useRefreshUploads(projectId: string) {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: videoKeys.jobs(projectId) });
    await qc.invalidateQueries({ queryKey: videoKeys.tab(projectId) });
  };
}

/** Bắt đầu hoặc tiếp tục gửi tệp của một việc; lượt tải sống tiếp khi rời tab. */
export function useStartUpload(projectId: string) {
  const t = useT();
  const qc = useQueryClient();
  const refresh = useRefreshUploads(projectId);
  return (jobId: string, file: File, upload: { id: string; partSize: number; partCount: number }, received: number[] = []) => {
    const live = new VideoUpload({ uploadId: upload.id, file, partSize: upload.partSize, partCount: upload.partCount, received });
    uploadRegistry.add(jobId, live);
    rememberLocalVideo(jobId, file);
    let phase = live.getSnapshot().phase;
    live.subscribe(() => {
      const snap = live.getSnapshot();
      if (snap.phase === phase) return;
      phase = snap.phase;
      // máy chủ có thể đã bỏ việc (tệp ghép không khớp, phiên đóng): báo ngay vì hàng tiến độ có thể biến mất
      if (phase === 'failed') {
        toast.error(snap.error?.message ?? t.video.upload.failed);
        void refresh();
      }
      if (phase !== 'done') return;
      uploadRegistry.remove(jobId);
      toast.success(t.video.upload.done);
      void qc.invalidateQueries({ queryKey: videoKeys.job(jobId) });
      void refresh();
    });
    live.start();
  };
}

/** Một video đang được gửi từ thẻ trình duyệt này: tiến độ, tốc độ, thời gian còn lại, tạm dừng, tiếp tục, hủy (FR-005, FR-006). */
export function LiveUpload({ projectId, job }: { projectId: string; job: VideoJobDto }) {
  const t = useT();
  const refresh = useRefreshUploads(projectId);
  const snap = useLiveUpload(job.id);
  const [confirming, setConfirming] = useState(false);
  if (!snap) return null;
  const u = t.video.upload;
  const phase = snap.phase === 'paused' ? u.paused : snap.phase === 'completing' || snap.phase === 'done' ? u.completing : snap.phase === 'failed' ? u.failed : u.uploading;
  const code = snap.error?.code;
  const problem = snap.needsLogin ? u.loginNeeded : !snap.error ? null : code === 'NETWORK' ? u.networkError : (snap.error.message ?? u.unexpectedError);

  return (
    <div className="space-y-2" data-testid="video-live-upload">
      <p className="truncate text-sm font-medium" title={job.fileName}>
        {job.fileName}
      </p>
      <div className="flex items-center gap-2">
        <Progress value={snap.percent} className="h-1.5 flex-1" aria-label={u.progressLabel} />
        <span className="text-xs tabular-nums text-muted-foreground">{snap.percent}%</span>
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">
        {/* chỉ tên giai đoạn được đọc to: số liệu đổi liên tục */}
        <span role="status">{phase}</span> · {fmtBytes(snap.sentBytes)} / {fmtBytes(snap.totalBytes)}
        {snap.bytesPerSecond !== null ? ` · ${fmt(u.speed, { speed: (snap.bytesPerSecond / 1048576).toFixed(1) })}` : null}
        {snap.remainingMs !== null ? ` · ${fmt(u.remaining, { time: fmtDuration(snap.remainingMs) })}` : null}
      </p>
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {snap.phase === 'uploading' ? (
          <Button size="sm" variant="outline" onClick={() => uploadRegistry.get(job.id)?.pause()}>
            <Pause className="size-3.5" />
            {u.pause}
          </Button>
        ) : null}
        {snap.phase === 'paused' ? (
          <Button size="sm" variant="outline" onClick={() => uploadRegistry.get(job.id)?.resume()}>
            <Play className="size-3.5" />
            {u.resume}
          </Button>
        ) : null}
        {snap.phase === 'failed' ? (
          // bỏ lượt gửi hỏng nhưng giữ phần đã tải: việc chuyển sang "đang tải dở" để chọn lại tệp
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              uploadRegistry.remove(job.id);
              void refresh();
            }}
          >
            {u.pickAgain}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          {u.cancel}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={u.cancelTitle}
        description={
          <>
            <p className="font-medium text-foreground">{fmt(u.cancelCount, { size: fmtBytes(snap.totalBytes) })}</p>
            <p className="break-all">{job.fileName}</p>
            <p>{u.cancelDesc}</p>
          </>
        }
        confirmLabel={u.cancelConfirm}
        onConfirm={async () => {
          const live = uploadRegistry.get(job.id);
          const uploadId = live?.uploadId ?? job.upload?.id;
          // giữ lượt tải (tạm dừng) tới khi máy chủ hủy xong, để việc không hiện lại ở mục "đang tải dở"
          live?.pause();
          try {
            if (uploadId) await apiDelete(`/api/video/uploads/${uploadId}`);
            uploadRegistry.remove(job.id);
            toast.success(u.cancelled);
          } catch (e) {
            toast.error(errorText(e, t.common.genericError));
          } finally {
            await refresh();
          }
        }}
      />
    </div>
  );
}

/** Việc tải dở (đã đóng trình duyệt hoặc tải lại trang): chọn lại đúng tệp để tải tiếp trong thời hạn giữ (FR-005). */
function UnfinishedUpload({ job, busy, error, onPick }: { job: VideoJobDto; busy: boolean; error: string | null; onPick: (file: File) => void }) {
  const t = useT();
  const fx = useFormat();
  const upload = job.upload!;
  const u = t.video.upload;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{fmt(u.unfinishedDesc, { name: job.fileName, size: fmtBytes(job.size), date: fx.dateTime(upload.expiresAt), percent: receivedPercent(job) })}</p>
      <FileDropzone accept={ACCEPT} label={`${u.resumePick}: ${job.fileName}`} inputLabel={`${u.resumePick}: ${job.fileName}`} title={u.resumePick} hint={job.fileName} buttonLabel={u.choose} icon={FileVideo} busy={busy} onPick={onPick} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Chọn video, hướng dịch và theo dõi việc tải lên (spec 006, US1). */
export function UploadPanel({ projectId, tab, jobs }: { projectId: string; tab: VideoTabDto; jobs: readonly VideoJobDto[] }) {
  const t = useT();
  const u = t.video.upload;
  const start = useStartUpload(projectId);
  const refresh = useRefreshUploads(projectId);
  useUploadVersion(); // lượt tải được thêm hoặc bỏ thì xếp lại hai danh sách
  const [file, setFile] = useState<File | null>(null);
  const [direction, setDirection] = useState<Direction>(tab.settings.direction);
  const [busy, setBusy] = useState(false);
  /** `jobId` rỗng: lỗi của biểu mẫu video mới */
  const [error, setError] = useState<{ jobId: string; text: string } | null>(null);
  const [other, setOther] = useState<{ file: File; job: VideoJobDto } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pending = jobs.filter((j) => j.upload);
  const sending = pending.filter((j) => uploadRegistry.get(j.id));
  const unfinished = pending.filter((j) => !uploadRegistry.get(j.id));
  /** đã đủ số việc đang chạy: muốn dịch tệp khác phải bỏ bản đang tải dở */
  const full = tab.quota.activeJobs >= tab.quota.maxJobs;

  const problemOf = (f: File): string | null =>
    !extensionOk(f.name) ? u.badType : f.size === 0 ? u.emptyFile : f.size > tab.limits.maxBytes ? fmt(u.tooLarge, { size: fmtBytes(tab.limits.maxBytes) }) : null;

  function pick(f: File) {
    if (busy) return;
    const problem = problemOf(f);
    setError(problem ? { jobId: '', text: problem } : null);
    setFile(problem ? null : f);
  }

  /** Tải tiếp việc đã có bằng đúng tệp: hỏi máy chủ các phần đã nhận. */
  async function resumeJob(job: VideoJobDto, f: File, fingerprint: string) {
    const state = await api<UploadStateResponse>(`/api/video/uploads/${job.upload!.id}?size=${f.size}&fingerprint=${fingerprint}`);
    start(job.id, f, state, state.parts);
    toast.success(u.resumed);
  }

  async function createJob(f: File) {
    const fingerprint = await fingerprintFile(f);
    // chọn đúng tệp đang tải dở thì tải tiếp thay vì tạo việc mới
    const same = unfinished.find((j) => j.size === f.size && j.fingerprint === fingerprint);
    if (same) return resumeJob(same, f, fingerprint);
    const created = await apiPost<{ job: VideoJobDto; upload: { id: string; partSize: number; partCount: number } }>(`/api/projects/${projectId}/video/jobs`, { fileName: f.name, size: f.size, fingerprint, direction });
    start(created.job.id, f, created.upload);
    toast.success(u.started);
  }

  async function run(jobId: string, action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      const text = errorText(e, t.common.genericError);
      // đã rời tab thì không còn chỗ hiện lỗi trong trang
      if (mounted.current) setError({ jobId, text });
      else toast.error(text);
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  function pickResume(job: VideoJobDto, f: File) {
    void run(job.id, async () => {
      const problem = problemOf(f);
      if (problem) throw new ApiError(422, 'VALIDATION', problem);
      const fingerprint = await fingerprintFile(f);
      // tệp được chọn có thể là của một bản tải dở khác
      const match = [job, ...unfinished].find((j) => j.size === f.size && j.fingerprint === fingerprint);
      if (!match) {
        setOther({ file: f, job });
        return;
      }
      await resumeJob(match, f, fingerprint);
    });
  }

  const formError = error && !unfinished.some((j) => j.id === error.jobId) ? error.text : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <section className="min-w-0 space-y-3 lg:col-span-7" aria-labelledby="video-upload-title">
        <h2 id="video-upload-title" className="text-base font-semibold">
          {u.title}
        </h2>
        <Card>
          <CardContent className="space-y-4 p-5">
            <p className="text-xs text-muted-foreground">{t.video.providerNote}</p>
            <FileDropzone
              variant="stack"
              accept={ACCEPT}
              label={u.pick}
              inputLabel={u.pick}
              title={busy ? u.preparing : (file?.name ?? u.pick)}
              hint={file ? fmtBytes(file.size) : fmt(u.hint, { size: fmtBytes(tab.limits.maxBytes), minutes: tab.limits.maxMinutes })}
              buttonLabel={u.choose}
              icon={FileVideo}
              busy={busy}
              hasFile={!!file}
              truncateTitle
              onPick={pick}
            />
            <SelectField label={u.direction} value={direction} onChange={(v) => setDirection(v as Direction)} options={DIRECTIONS.map((d) => ({ value: d, label: u.directions[d] }))} />
            <p className="text-xs text-muted-foreground">
              {fmt(u.glossary, { n: tab.settings.glossary.length })}{' '}
              <a href="#video-glossary-title" className="underline underline-offset-4 hover:text-foreground">
                {u.glossaryLink}
              </a>
            </p>
            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}
            <div className="flex justify-end pt-2">
              <Button
                disabled={!file || busy}
                onClick={() =>
                  file &&
                  void run('', async () => {
                    await createJob(file);
                    setFile(null);
                  })
                }
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {u.preparing}
                  </>
                ) : (
                  u.start
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="min-w-0 space-y-3 lg:col-span-5" aria-labelledby="video-quota-title">
        <h2 id="video-quota-title" className="text-base font-semibold">
          {u.storageTitle}
        </h2>
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-2">
              <p className="text-xs tabular-nums text-muted-foreground">
                {fmt(u.quota, { used: fmtBytes(tab.quota.usedBytes + tab.quota.reservedBytes), quota: fmtBytes(tab.quota.quotaBytes) })}
              </p>
              <Progress value={Math.min(100, ((tab.quota.usedBytes + tab.quota.reservedBytes) / Math.max(1, tab.quota.quotaBytes)) * 100)} aria-label={u.storageTitle} />
              <p className="text-xs text-muted-foreground">{fmt(u.retention, { hours: tab.retention.sourceHours, days: tab.retention.idleDays, outputDays: tab.retention.outputDays })}</p>
            </div>

            {sending.length > 0 ? (
              <>
                <Separator />
                {sending.map((j) => (
                  <LiveUpload key={j.id} projectId={projectId} job={j} />
                ))}
              </>
            ) : null}

            {unfinished.length > 0 ? (
              <>
                <Separator />
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">{u.unfinishedTitle}</h3>
                  <Badge variant="secondary">{unfinished.length}</Badge>
                </div>
                {unfinished.map((j) => (
                  <UnfinishedUpload key={j.id} job={j} busy={busy} error={error?.jobId === j.id ? error.text : null} onPick={(f) => pickResume(j, f)} />
                ))}
              </>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <ConfirmDialog
        open={!!other}
        onOpenChange={(o) => !o && setOther(null)}
        title={u.otherFileTitle}
        destructive={full}
        description={
          other ? (
            <>
              <p>{fmt(u.otherFileDesc, { chosen: other.file.name, name: other.job.fileName })}</p>
              {full ? <p>{fmt(u.otherFileFull, { name: other.job.fileName, percent: receivedPercent(other.job) })}</p> : null}
            </>
          ) : null
        }
        confirmLabel={full ? u.replaceUpload : u.createNew}
        onConfirm={async () => {
          if (!other) return;
          await run('', async () => {
            if (full) {
              // không bỏ bản dở khi biết chắc tệp mới vẫn không đủ hạn mức
              if (tab.quota.remainingBytes + other.job.upload!.sizeBytes < other.file.size) throw new ApiError(409, 'VIDEO_QUOTA_EXCEEDED', u.noRoom);
              // hủy phiên tải dở: việc chưa có phụ đề bị xóa, việc đã có phụ đề được giữ
              await apiDelete(`/api/video/uploads/${other.job.upload!.id}`);
            }
            await createJob(other.file);
          });
        }}
      />
    </div>
  );
}
