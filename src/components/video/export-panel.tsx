'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Download, FileVideo, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { SelectField } from '@/components/overlay/fields';
import { FileDropzone } from '@/components/shared/file-dropzone';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { LiveUpload, useStartUpload } from '@/components/video/upload-panel';
import { ApiError, api, apiPost } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useLiveUpload, videoKeys, type VideoJobDetailDto } from '@/lib/hooks/use-video';
import { useFormat, useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import type { ExportEstimateDto } from '@/lib/video/exports';
import { fingerprintFile } from '@/lib/video/fingerprint';
import { SUBTITLE_CONTENTS, SUBTITLE_FORMATS, type SubtitleContent, type SubtitleFormat } from '@/lib/video/subtitle-files';
import { videoLogText } from '@/lib/video/text';
import { VIDEO_EXTENSIONS } from '@/lib/video/types';

const ACCEPT = VIDEO_EXTENSIONS.map((e) => `.${e}`).join(',');
const messageOf = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
/** Lý do khóa xuất có thể tự hết mà việc này không đổi gì. */
const CHANGES_ELSEWHERE = new Set(['VIDEO_NOT_ALLOWED', 'VIDEO_TOO_MANY_JOBS', 'VIDEO_QUOTA_EXCEEDED', 'VIDEO_SYSTEM_FULL']);

/** Lý do lượt tải lại gần nhất bị loại: việc không đổi trạng thái nên chỉ nhật ký ghi lại. */
function rejectedReason(job: VideoJobDetailDto): VideoJobDetailDto['logs'][number] | null {
  if (job.sourceState !== 'deleted') return null;
  const own = job.logs.filter((l) => !l.exportId);
  const uploaded = own.findLastIndex((l) => l.messageKey === 'uploadDone');
  if (uploaded < 0) return null;
  // lượt kiểm chỉ ghi "đang chuẩn bị" và "thử lại" trước khi báo lỗi; lượt dịch hỏng luôn có bước khác chen giữa
  const next = own.slice(uploaded + 1).find((l) => l.messageKey !== 'preparing' && l.messageKey !== 'retrying');
  return next?.messageKey === 'failed' ? next : null;
}

/** Phiên tải lại đúng video gốc khi nó đã hết hạn giữ (FR-046); không dịch lại. */
function Reupload({ job }: { job: VideoJobDetailDto }) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const r = t.video.export.reupload;
  const u = t.video.upload;
  const start = useStartUpload(job.projectId);
  const live = useLiveUpload(job.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rejected = rejectedReason(job);

  async function pick(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fingerprint = await fingerprintFile(file);
      if (file.size !== job.size || fingerprint !== job.fingerprint) return setError(r.mismatch);
      // còn phiên dở thì tải tiếp từ phần đã nhận, chưa có thì mở phiên mới
      if (job.upload) {
        const state = await api<{ id: string; partSize: number; partCount: number; parts: number[] }>(`/api/video/uploads/${job.upload.id}?size=${file.size}&fingerprint=${fingerprint}`);
        start(job.id, file, state, state.parts);
      } else start(job.id, file, await apiPost<{ id: string; partSize: number; partCount: number }>(`/api/video/jobs/${job.id}/source`, { size: file.size, fingerprint }));
      toast.success(r.started);
    } catch (e) {
      setError(messageOf(e, t.common.genericError));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: videoKeys.job(job.id) });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <h3 className="text-sm font-medium">{job.upload ? u.unfinishedTitle : r.title}</h3>
      <p className="text-xs text-muted-foreground">
        {job.upload && !live
          ? fmt(u.unfinishedDesc, {
              name: job.fileName,
              size: fmtBytes(job.size),
              date: fx.dateTime(job.upload.expiresAt),
              percent: Math.floor((job.upload.receivedBytes / Math.max(1, job.upload.sizeBytes)) * 100),
            })
          : fmt(r.desc, { name: job.fileName, size: fmtBytes(job.size) })}
      </p>
      {rejected && !job.upload ? (
        <p role="alert" className="text-sm text-destructive">
          {videoLogText(t, rejected)}
        </p>
      ) : null}
      {live ? (
        <LiveUpload projectId={job.projectId} job={job} />
      ) : (
        <FileDropzone accept={ACCEPT} label={r.pick} inputLabel={r.pick} title={r.pick} hint={job.fileName} buttonLabel={t.video.upload.choose} icon={FileVideo} busy={busy} spinButton onPick={(f) => void pick(f)} />
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Tải `.srt`, `.vtt` và lưu thành kịch bản (FR-039, FR-040). */
function SubtitleFiles({ job, revision, ensureSaved }: { job: VideoJobDetailDto; revision: number; ensureSaved: () => Promise<number | null> }) {
  const t = useT();
  const e = t.video.export;
  const qc = useQueryClient();
  const [format, setFormat] = useState<SubtitleFormat>('srt');
  const [content, setContent] = useState<SubtitleContent>('target');
  /** phiên bản phụ đề của lượt lưu kịch bản gần nhất; null khi chính việc lưu phụ đề không thành */
  const [triedRevision, setTriedRevision] = useState<number | null>(null);
  const toScript = useMutation({
    mutationFn: async (chosen: SubtitleContent) => {
      const saved = await ensureSaved();
      setTriedRevision(saved);
      if (saved === null) throw new ApiError(409, 'CONFLICT', e.saveFirst);
      return apiPost(`/api/video/jobs/${job.id}/to-script`, { content: chosen });
    },
    onSuccess: () => {
      toast.success(e.scriptSaved);
      void qc.invalidateQueries({ queryKey: ['project', job.projectId] });
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  async function download() {
    // tệp lấy theo bản đã lưu: lưu nốt trước khi tải
    if ((await ensureSaved()) === null) return void toast.error(e.saveFirst);
    // đọc qua fetch để lỗi (không có chữ, hết phiên) hiện ngay trong trang
    const res = await fetch(`/api/video/jobs/${job.id}/subtitles?format=${format}&content=${content}`, { credentials: 'same-origin' }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null;
      return void toast.error(body?.error?.message ?? e.downloadError);
    }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `subtitles.${format}`);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <section className="space-y-3" aria-labelledby="video-subtitles-title">
      <h2 id="video-subtitles-title" className="text-base font-semibold">
        {e.subtitlesTitle}
      </h2>
      <Card>
        <CardContent className="space-y-4 p-5">
          <p className="text-xs text-muted-foreground">{e.subtitlesDesc}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SelectField label={e.format} value={format} onChange={setFormat} options={SUBTITLE_FORMATS.map((f) => ({ value: f, label: `.${f}` }))} />
            <SelectField label={e.content} value={content} onChange={setContent} options={SUBTITLE_CONTENTS.map((c) => ({ value: c, label: e.contents[c] }))} />
          </div>
          {toScript.isError && toScript.variables === content && (triedRevision === null || triedRevision === revision) ? (
            <p role="alert" className="text-sm text-destructive">
              {messageOf(toScript.error, t.common.genericError)}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" disabled={toScript.isPending} onClick={() => toScript.mutate(content)}>
              {toScript.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              {e.toScript}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void download()}>
              <Download className="size-3.5" />
              {e.download}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Ước tính, lưu ý và nút xuất video gắn phụ đề (spec 006, US3; FR-042, FR-043). Máy chủ kiểm tra lại mọi điều kiện khi tạo bản xuất.
 * `ensureSaved` lưu nốt phụ đề và trả số phiên bản đã lưu (null khi không lưu được).
 */
export function ExportPanel({
  job,
  revision,
  ensureSaved,
  styleVersion,
  ensureStyleSaved,
}: {
  job: VideoJobDetailDto;
  revision: number;
  ensureSaved: () => Promise<number | null>;
  /** tăng sau mỗi lần lưu kiểu phụ đề: lưu ý và ước tính phụ thuộc kiểu */
  styleVersion: number;
  ensureStyleSaved: () => Promise<boolean>;
}) {
  const t = useT();
  const e = t.video.export;
  const qc = useQueryClient();
  const [kind, setKind] = useState<'burn' | 'layer'>('burn');
  const [layerFormat, setLayerFormat] = useState<'mp4' | 'mov'>('mp4');
  const format = kind === 'burn' ? 'mp4' : layerFormat;
  const jobState = [job.status, job.sourceState, job.exports.map((x) => `${x.id}:${x.status}`).join()].join('|');
  const createKey = `${jobState}|${kind}|${format}`;
  // đổi phụ đề, kiểu, lựa chọn loại xuất, trạng thái việc, video nguồn hay bản xuất thì ước tính lại
  const situation = `${revision}|${styleVersion}|${jobState}`;
  const estimate = useQuery({
    queryKey: ['video-estimate', job.id, situation, kind, format],
    queryFn: () => apiPost<ExportEstimateDto>(`/api/video/jobs/${job.id}/exports/estimate`, { kind, format }),
    gcTime: 0,
    placeholderData: keepPreviousData,
    // lý do khóa có thể hết vì việc ở nơi khác (quyền, số việc, hạn mức): hỏi lại; lý do thuộc việc này đã đổi `situation`
    refetchInterval: (q) => (CHANGES_ELSEWHERE.has(q.state.data?.blocked ?? '') ? 5000 : false),
  });
  // biến của lượt gọi là trạng thái việc + lựa chọn xuất lúc bấm (không gồm phiên bản phụ đề: lượt bấm tự lưu nên phiên bản đổi ngay)
  const create = useMutation<unknown, Error, string>({
    mutationFn: async () => {
      // bản xuất chốt nội dung và kiểu ở máy chủ nên cả hai phải lưu xong
      if (!(await ensureStyleSaved())) throw new ApiError(409, 'CONFLICT', e.styleSaveFirst);
      const saved = await ensureSaved();
      if (saved === null) throw new ApiError(409, 'CONFLICT', e.saveFirst);
      return apiPost(`/api/video/jobs/${job.id}/exports`, { kind, format, baseRevision: saved });
    },
    onSuccess: () => toast.success(e.queued),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: videoKeys.job(job.id) });
      await qc.invalidateQueries({ queryKey: videoKeys.jobs(job.projectId) });
    },
  });

  const data = estimate.data;
  const live = useLiveUpload(job.id);
  const reupload = job.sourceState === 'deleted' || (job.sourceState === 'uploading' && !!job.media && job.media.videoCodec !== 'pending');
  const initialUploading = job.sourceState === 'uploading' && !reupload;
  const uploadPercent = live ? live.percent : job.upload ? Math.floor((job.upload.receivedBytes / Math.max(1, job.upload.sizeBytes)) * 100) : 0;
  const blockedText = data?.blocked ? ((t.errors as Record<string, string>)[data.blocked] ?? t.common.genericError) : null;
  // đang có bản xuất hoặc video nguồn đang tải lên là trạng thái chờ bình thường, không báo lỗi đỏ
  const busyText = data?.blocked === 'VIDEO_EXPORT_RUNNING' || data?.blocked === 'VIDEO_SOURCE_NOT_READY' ? blockedText : null;
  // lỗi chỉ còn nghĩa khi việc chưa đổi trạng thái kể từ lúc bấm
  const problem = busyText ? null : (blockedText ?? (create.isError && create.variables === createKey ? messageOf(create.error, t.common.genericError) : null));

  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="video-export-title">
        <h2 id="video-export-title" className="text-base font-semibold">
          {e.title}
        </h2>
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField
                label={e.kind}
                value={kind}
                onChange={(v) => setKind(v)}
                options={[
                  { value: 'burn', label: e.kinds.burn },
                  { value: 'layer', label: e.kinds.layer },
                ]}
              />
              {kind === 'layer' ? (
                <SelectField
                  label={e.layerBackground}
                  value={layerFormat}
                  onChange={(v) => setLayerFormat(v)}
                  options={[
                    { value: 'mp4', label: e.layerFormats.mp4 },
                    { value: 'mov', label: e.layerFormats.mov },
                  ]}
                />
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{kind === 'layer' ? e.layerDesc : e.desc}</p>
            {kind === 'layer' && format === 'mov' ? <p className="text-xs text-muted-foreground">{e.layerMovHint}</p> : null}
            {reupload ? <Reupload job={job} /> : null}
            {initialUploading ? (
              live ? (
                <div className="rounded-lg border p-3">
                  <LiveUpload projectId={job.projectId} job={job} />
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border p-3" data-testid="video-source-export-progress">
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span role="status">{t.video.editor.preview.audioWhileUploading}</span>
                    <span className="tabular-nums">{uploadPercent}%</span>
                  </div>
                  <Progress value={uploadPercent} className="h-1.5" aria-label={t.video.upload.progressLabel} />
                </div>
              )
            ) : null}
            {job.sourceState === 'checking' ? (
              <p role="status" className="text-sm text-muted-foreground">
                {e.reupload.checking}
              </p>
            ) : null}

            {estimate.isPending ? (
              <LoadingList rows={2} />
            ) : !data ? (
              <ErrorState message={e.estimateError} onRetry={() => void estimate.refetch()} />
            ) : data.estimatedBytes > 0 && job.media?.videoCodec !== 'pending' ? (
              <section aria-label={e.estimateTitle} className="space-y-2 rounded-lg border p-3">
                <h3 className="text-sm font-medium">{e.estimateTitle}</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">{e.frame}</dt>
                  <dd className="text-right tabular-nums">
                    {data.width}×{data.height}
                  </dd>
                  <dt className="text-muted-foreground">{e.size}</dt>
                  <dd className="text-right tabular-nums" data-testid="video-estimate-size">
                    ~{fmtBytes(data.estimatedBytes)}
                  </dd>
                  <dt className="text-muted-foreground">{e.time}</dt>
                  <dd className="text-right tabular-nums">~{fmtDuration(data.estimatedSeconds * 1000)}</dd>
                  <dt className="text-muted-foreground">{e.remaining}</dt>
                  <dd className="text-right tabular-nums">{fmtBytes(data.remainingBytes)}</dd>
                </dl>
                <p className="text-xs text-muted-foreground">{e.estimateNote}</p>
              </section>
            ) : null}

            {data && data.warnings.length > 0 ? (
              <div role="status" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium">{e.warningsTitle}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {data.warnings.map((w) => (
                    <li key={w.code}>{fmt(e.warnings[w.code], w.params ?? {})}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {busyText ? (
              <p role="status" className="text-sm text-muted-foreground">
                {busyText}
              </p>
            ) : null}
            {problem ? (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            ) : null}

            <div className="flex justify-end pt-2">
              <Button disabled={!data || estimate.isPlaceholderData || !!data.blocked || create.isPending} onClick={() => create.mutate(createKey)}>
                {create.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {e.starting}
                  </>
                ) : (
                  e.start
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
      <SubtitleFiles job={job} revision={revision} ensureSaved={ensureSaved} />
    </div>
  );
}
