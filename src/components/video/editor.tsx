'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EventLog } from '@/components/shared/event-log';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import type { CueActions } from '@/components/video/cue-editing';
import { CueList } from '@/components/video/cue-list';
import { ExportList } from '@/components/video/export-list';
import { ExportPanel } from '@/components/video/export-panel';
import { VideoStatusBadge } from '@/components/video/status';
import { StylePanel } from '@/components/video/style-panel';
import { Timeline } from '@/components/video/timeline';
import { VideoPreview } from '@/components/video/video-preview';
import { ApiError, api } from '@/lib/api-client';
import { fmtDuration } from '@/lib/format';
import { useCueEditor } from '@/lib/hooks/use-cue-editor';
import { useActiveCue } from '@/lib/hooks/use-media-clock';
import { useStyleEditor } from '@/lib/hooks/use-style-editor';
import { useVideoEvents, useVideoJob, type VideoJobDetailDto } from '@/lib/hooks/use-video';
import { newRequestId } from '@/lib/hooks/use-overlay';
import { useFormat, useT } from '@/lib/i18n/client';
import { fmt } from '@/lib/i18n/fmt';
import { insertAfterOp, mergeOps, nudgeOp, setEdgeOp, splitOps, type Caret, type CueOp } from '@/lib/video/cue-ops';
import type { CueListDto } from '@/lib/video/cues';
import { videoErrorText, videoLogText } from '@/lib/video/text';
import { CUE_LIMITS, type VideoMedia } from '@/lib/video/types';

function JobLog({ job }: { job: VideoJobDetailDto }) {
  const t = useT();
  return <EventLog label={t.video.list.logLabel} empty={t.video.list.logEmpty} entries={job.logs.map((l) => ({ id: l.id, ts: l.ts, level: l.level, text: videoLogText(t, l) }))} />;
}

/** Chưa có kịch bản: tiến độ và nhật ký cho tới khi dịch xong; việc đã dừng hoặc lỗi thì chỉ cách làm tiếp. */
function Waiting({ job }: { job: VideoJobDetailDto }) {
  const t = useT();
  const e = t.video.editor;
  const ended = job.status === 'failed' || job.status === 'stopped';
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-base font-medium">{e.waitingTitle}</p>
      <p className="text-sm text-muted-foreground">{ended ? e.stoppedDesc : e.waitingDesc}</p>
      {ended ? null : (
        <div className="flex items-center gap-2">
          <Progress value={job.progressPercent} className="h-1.5 flex-1" aria-label={t.video.list.progressLabel} />
          <span className="text-xs tabular-nums text-muted-foreground">{job.progressPercent}%</span>
        </div>
      )}
      <JobLog job={job} />
    </div>
  );
}

function Workspace({ job, media, loaded, reload }: { job: VideoJobDetailDto; media: VideoMedia; loaded: CueListDto; reload: () => Promise<CueListDto | undefined> }) {
  const t = useT();
  const e = t.video.editor;
  const tools = e.tools;
  const editor = useCueEditor(job.id, loaded, media.durationMs);
  const { store, cues } = editor;
  const styleEditor = useStyleEditor(job);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const active = useActiveCue(mediaRef, cues);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** cue chờ xác nhận xóa; giữ nội dung trong lúc hộp thoại đóng */
  const [removing, setRemoving] = useState<{ id: string; number: number; text: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [reveal, setReveal] = useState<{ id: string } | null>(null);
  const carets = useRef(new Map<string, Caret>());
  const readOnly = !job.editable || editor.status === 'conflict';

  // tab khác đã lưu hoặc vừa dịch lại xong: đọc lại khi không còn gì chưa lưu
  const behind = job.cueRevision > editor.revision && editor.status === 'saved';
  useEffect(() => {
    if (behind) void reload();
  }, [behind, job.cueRevision, reload]);

  /** Áp thao tác; `false` khi không có gì đổi hoặc bị từ chối. */
  const run = (ops: CueOp[], opts: { merge?: string } = {}): boolean => {
    if (store.getSnapshot().status === 'conflict') return false;
    const violation = store.apply(ops, opts);
    if (!violation) return true;
    toast.error(violation.reason === 'too_many' ? tools.tooMany : violation.reason === 'text' ? tools.tooLong : tools.rejected);
    return false;
  };
  /** Đọc danh sách mới nhất từ kho (nhiều thao tác có thể tới giữa hai lần vẽ). */
  const latest = () => store.getSnapshot().cues;
  const seek = (ms: number) => {
    if (mediaRef.current) mediaRef.current.currentTime = ms / 1000;
  };
  /** Chọn cue vừa tạo (hoặc cue kề cue vừa xóa) và đưa người dùng tới đó. */
  const show = (id: string) => {
    setSelectedId(id);
    setReveal({ id });
  };
  const addFirst = () => {
    const newId = newRequestId();
    const op = insertAfterOp(latest(), null, newId, media.durationMs);
    if (!op) return void toast.error(tools.noRoom);
    if (run([op])) show(newId);
  };

  const actions: CueActions = {
    text: (id, column, value) => run([{ type: 'update', id, patch: column === 'source' ? { sourceText: value } : { targetText: value } }], { merge: `${column}:${id}` }),
    caret: (id, caret) => carets.current.set(id, caret),
    setEdge: (id, edge, ms) => {
      const op = setEdgeOp(latest(), id, edge, ms, media.durationMs);
      if (op) run([op], { merge: `${edge}:${id}` });
    },
    nudge: (id, edge, delta) => {
      const op = nudgeOp(latest(), id, edge, delta, media.durationMs);
      if (op) run([op]);
    },
    split: (id) => {
      const newId = newRequestId();
      const ops = splitOps(latest(), id, newId, carets.current.get(id));
      if (!ops) return void toast.error(tools.cannotSplit);
      carets.current.delete(id);
      if (run(ops)) show(newId);
    },
    merge: (id) => {
      const ops = mergeOps(latest(), id);
      if (!ops) return;
      const patch = ops[0]?.type === 'update' ? ops[0].patch : null;
      if (Math.max(patch?.sourceText?.length ?? 0, patch?.targetText?.length ?? 0) > CUE_LIMITS.maxTextChars) return void toast.error(tools.tooLong);
      run(ops);
    },
    addAfter: (id) => {
      const newId = newRequestId();
      const op = insertAfterOp(latest(), id, newId, media.durationMs);
      if (!op) return void toast.error(tools.noRoom);
      if (run([op])) show(newId);
    },
    addFirst,
    remove: (id) => {
      const index = latest().findIndex((c) => c.id === id);
      const cue = latest()[index];
      if (!cue) return;
      setRemoving({ id, number: index + 1, text: cue.targetText || cue.sourceText });
      setRemoveOpen(true);
    },
  };

  const status = e.save[editor.status === 'conflict' ? 'error' : editor.status];
  /** Lưu nốt phụ đề trước khi xuất hoặc tải tệp; null khi không lưu được. */
  const ensureSaved = async (): Promise<number | null> => {
    // mỗi lần gửi một lô; vài lượt là đủ cho phần vừa gõ trong lúc đang gửi
    for (let i = 0; i < 3 && store.getSnapshot().status !== 'saved'; i++) await store.flush();
    const now = store.getSnapshot();
    return now.status === 'saved' ? now.revision : null;
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* lỗi lưu và xung đột thấy được ở mọi tab */}
      {/* giữ dải báo trong lúc thử lại để trang không xê dịch */}
      {editor.error && editor.status !== 'conflict' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive lg:col-span-12">
          <span>
            {e.save.error} {editor.error?.message}
          </span>
          <Button size="sm" variant="outline" onClick={() => store.retry()}>
            {t.common.retry}
          </Button>
        </div>
      ) : null}
      {styleEditor.error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive lg:col-span-12">
          <span>
            {e.style.saveError} {styleEditor.error}
          </span>
          <Button size="sm" variant="outline" disabled={styleEditor.status === 'saving'} onClick={() => styleEditor.store.retry()}>
            {t.common.retry}
          </Button>
        </div>
      ) : null}
      {editor.status === 'conflict' ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 lg:col-span-12" data-testid="save-conflict">
          <p className="text-sm font-medium">{editor.error?.message ?? e.save.error}</p>
          <p className="text-xs text-muted-foreground">{e.save.reloadNote}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const fresh = await reload();
              if (fresh) store.reset(fresh.cues, fresh.revision);
              else toast.error(e.cuesError);
            }}
          >
            {e.save.reload}
          </Button>
        </div>
      ) : null}
      {/* xem trước: cột phải, bám theo khi cuộn trên màn hình rộng; đứng trước trong thứ tự trang nên tới được ngay bằng phím Tab */}
      <div className="min-w-0 lg:order-2 lg:col-span-5">
        {/* video dọc kèm lựa chọn vùng an toàn có thể cao hơn màn hình: cột tự cuộn */}
        <div className="space-y-3 lg:sticky lg:top-4 lg:-m-1 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:p-1">
          <VideoPreview job={job} media={media} cues={cues} style={styleEditor.style} mediaRef={mediaRef} />
          <Timeline cues={cues} selectedId={selectedId} durationMs={media.durationMs} mediaRef={mediaRef} disabled={readOnly} onChange={actions.setEdge} />
        </div>
      </div>
      <div className="min-w-0 lg:order-1 lg:col-span-7">
        <Tabs defaultValue="cues">
          <TabsList aria-label={e.tabsLabel} className="flex h-auto flex-wrap group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="cues">
              {e.tabCues} ({cues.length})
            </TabsTrigger>
            <TabsTrigger value="style">{e.tabStyle}</TabsTrigger>
            <TabsTrigger value="export">{t.video.export.tab}</TabsTrigger>
            <TabsTrigger value="log">{e.tabLog}</TabsTrigger>
          </TabsList>
          <TabsContent value="cues" className="space-y-3">
            {!job.editable ? (
              <p role="status" className="text-sm text-muted-foreground">
                {e.readOnly}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={readOnly || !editor.canUndo} onClick={() => store.undo()}>
                <Undo2 className="size-3.5" />
                {tools.undo}
              </Button>
              <Button size="sm" variant="outline" disabled={readOnly || !editor.canRedo} onClick={() => store.redo()}>
                <Redo2 className="size-3.5" />
                {tools.redo}
              </Button>
              {editor.status !== 'conflict' && !editor.error ? (
                <span role="status" className="ml-auto text-xs text-muted-foreground" data-testid="save-status">
                  {status}
                </span>
              ) : null}
            </div>
            {cues.length === 0 ? (
              <EmptyState
                title={e.list.empty}
                description={readOnly ? undefined : e.list.emptyDesc}
                action={
                  readOnly ? undefined : (
                    <Button size="sm" onClick={addFirst}>
                      {tools.addFirst}
                    </Button>
                  )
                }
              />
            ) : (
              <CueList
                cues={cues}
                active={active}
                selectedId={selectedId}
                readOnly={readOnly}
                actions={actions}
                reveal={reveal}
                onRevealed={() => setReveal(null)}
                onSeek={(index) => {
                  const cue = cues[index];
                  if (cue) seek(cue.startMs);
                }}
                onSelect={(id) => {
                  if (id === selectedId) return;
                  setSelectedId(id);
                  // đang dừng và ở ngoài cue: nhảy tới đầu cue để khung xem trước hiện đúng chữ đang sửa
                  const cue = latest().find((c) => c.id === id);
                  const el = mediaRef.current;
                  if (cue && el?.paused && (el.currentTime * 1000 < cue.startMs || el.currentTime * 1000 >= cue.endMs)) seek(cue.startMs);
                }}
                onPlayFrom={(index) => {
                  const cue = cues[index];
                  if (!cue) return;
                  setSelectedId(cue.id);
                  seek(cue.startMs);
                  void mediaRef.current?.play().catch(() => toast.error(e.preview.playError));
                }}
              />
            )}
          </TabsContent>
          <TabsContent value="style">
            <StylePanel style={styleEditor.style} status={styleEditor.status} onChange={(next) => styleEditor.store.set(next)} />
          </TabsContent>
          <TabsContent value="export" className="space-y-6">
            <ExportPanel job={job} revision={editor.revision} ensureSaved={ensureSaved} styleVersion={styleEditor.savedVersion} ensureStyleSaved={() => styleEditor.store.flush()} />
            <ExportList job={job} revision={editor.revision} />
          </TabsContent>
          <TabsContent value="log">
            <JobLog job={job} />
          </TabsContent>
        </Tabs>
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={tools.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{fmt(tools.deleteCount, { n: removing?.number ?? 0 })}</p>
            <p className="break-words">{removing?.text}</p>
            <p>{tools.deleteDesc}</p>
          </>
        }
        confirmLabel={t.common.delete}
        onConfirm={() => {
          const index = latest().findIndex((c) => c.id === removing?.id);
          if (!removing || index < 0 || !run([{ type: 'delete', id: removing.id }])) return;
          toast.success(tools.deleted);
          // tiêu điểm chuyển sang cue kề bên thay vì rơi về đầu trang
          const next = latest()[Math.min(index, latest().length - 1)];
          if (next) setTimeout(() => show(next.id), 0);
          else setSelectedId(null);
        }}
      />
    </div>
  );
}

function Loaded({ job, media }: { job: VideoJobDetailDto; media: VideoMedia }) {
  const t = useT();
  // không giữ bản đệm sau khi rời trang: mở lại phải đọc bản vừa lưu, nếu không lần sửa đầu sẽ báo xung đột giả
  const q = useQuery({ queryKey: ['video-cues', job.id], queryFn: () => api<CueListDto>(`/api/video/jobs/${job.id}/cues`), gcTime: 0 });
  const { refetch } = q;
  // đọc lại lỗi thì không trả bản cũ: nơi gọi không được bỏ thay đổi chưa lưu để nhận lại dữ liệu cũ
  const reload = useCallback(async () => {
    const r = await refetch();
    return r.isError ? undefined : r.data;
  }, [refetch]);
  if (q.isPending) return <LoadingList rows={4} />;
  // lỗi khi hỏi lại không được gỡ trình biên tập đang có (còn thay đổi chưa lưu)
  if (!q.data) return <ErrorState message={t.video.editor.cuesError} onRetry={() => void q.refetch()} />;
  return <Workspace job={job} media={media} loaded={q.data} reload={reload} />;
}

/** Trang biên tập phụ đề của một việc dịch (spec 006, US2). */
export function VideoEditor({ projectId, jobId }: { projectId: string; jobId: string }) {
  const t = useT();
  const fx = useFormat();
  const e = t.video.editor;
  const q = useVideoJob(jobId);
  // bản xuất mới hay video nguồn tải lại làm việc "chạy" trở lại: mở lại luồng sự kiện
  useVideoEvents(jobId, `${q.data?.displayStatus ?? ''}|${q.data?.previewState ?? ''}|${q.data?.sourceState ?? ''}`);

  if (q.isPending) return <LoadingList rows={4} />;
  const gone = (q.error instanceof ApiError && q.error.status === 404) || (!!q.data && q.data.projectId !== projectId);
  if (!q.data || gone) return <ErrorState message={gone ? e.notFound : q.error?.message} onRetry={() => void q.refetch()} />;
  const job = q.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold" title={job.fileName}>
            {job.fileName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {job.durationMs !== null ? `${fmtDuration(job.durationMs)} · ` : null}
            {t.video.upload.directions[job.direction]} · {fmt(e.created, { date: fx.dateTime(job.createdAt) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VideoStatusBadge status={job.displayStatus} />
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}?tab=video`}>{e.back}</Link>
          </Button>
        </div>
      </div>
      {job.media && job.media.audioStreams > 1 ? <p className="text-xs text-muted-foreground">{fmt(e.audioStream, { count: job.media.audioStreams, n: job.media.audioNumber ?? 1 })}</p> : null}
      {job.errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {videoErrorText(t, job.errorCode)}
        </p>
      ) : null}
      {job.media && (job.editable || job.cueCount > 0) ? <Loaded job={job} media={job.media} /> : <Waiting job={job} />}
    </div>
  );
}
