'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Import } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { StartJobDialog } from '@/components/jobs/start-job-dialog';
import { EditProjectDialog } from '@/components/projects/edit-project-dialog';
import { FilePreviewDialog } from '@/components/projects/file-preview-dialog';
import { ImportMediaDialog } from '@/components/projects/import-media-dialog';
import { OverlayTab } from '@/components/overlay/overlay-tab';
import { JobTable, type JobRowDto } from '@/components/projects/job-table';
import { MediaTab } from '@/components/projects/media-tab';
import { ScriptEditor } from '@/components/projects/script-editor';
import { SttActiveBanner, SttJobList } from '@/components/projects/stt-dialog';
import { UploadDropzone } from '@/components/projects/upload-dropzone';
import { VideoTab } from '@/components/video/video-tab';
import { ApiError, api, apiDelete } from '@/lib/api-client';
import { OVERLAY_ACTIVE, useOverlayJobs } from '@/lib/hooks/use-overlay';
import { STT_ACTIVE, useSttJobs } from '@/lib/hooks/use-stt-jobs';
import { isVideoActive, useVideoJobs } from '@/lib/hooks/use-video';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { fmt } from '@/lib/i18n/fmt';
import { useFormat, useT } from '@/lib/i18n/client';

type FileDto = { id: string; originalName: string; ext: string; sizeBytes: number; charCount: number; segmentCount: number; hasTimecodes?: boolean; cueCount?: number | null; durationMs?: number | null; createdAt: string };
type VoiceDto = { id: string; title: string; fileId?: string; durationMs: number; sizeBytes: number; createdAt: string };
export type ProjectDetailDto = {
  id: string;
  name: string;
  description: string | null;
  providerType: string;
  createdAt: string;
  updatedAt: string;
  files: FileDto[];
  jobs: JobRowDto[];
  voices: VoiceDto[];
};

const ACTIVE = new Set(['queued', 'running']);

const PROJECT_TABS = ['files', 'media', 'jobs', 'voices', 'overlay', 'video'];

/** `initialTab`: tab mở sẵn khi quay về từ trang con (ví dụ trình biên tập video). */
export function ProjectDetail({ projectId, initialTab }: { projectId: string; initialTab?: string }) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const router = useRouter();
  const [tab, setTab] = useState(initialTab && PROJECT_TABS.includes(initialTab) ? initialTab : 'files');
  const [editOpen, setEditOpen] = useState(false);
  const [deleteProject, setDeleteProject] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [startFileId, setStartFileId] = useState<string | null>(null);
  const [deleteFile, setDeleteFile] = useState<FileDto | null>(null);
  const [importMediaOpen, setImportMediaOpen] = useState(false);

  const sttJobs = useSttJobs(projectId);
  const completedSttCount = (sttJobs.data ?? []).filter((j) => j.status === 'completed' && j.resultSubtitleFileId).length;
  const activeSttJobs = (sttJobs.data ?? []).filter((j) => STT_ACTIVE.has(j.status)).length;
  const overlayJobs = useOverlayJobs(projectId);
  const activeOverlayJobs = (overlayJobs.data ?? []).filter((j) => OVERLAY_ACTIVE.has(j.status)).length;
  const videoJobs = useVideoJobs(projectId);
  const activeVideoJobs = (videoJobs.data ?? []).filter(isVideoActive).length;

  const q = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetailDto>(`/api/projects/${projectId}`),
    // Cập nhật định kỳ khi còn tiến trình đang chạy (FR-002)
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => ACTIVE.has(j.status)) || activeSttJobs > 0 ? 3000 : false,
  });

  if (q.isPending) return <LoadingList rows={4} />;
  // hỏi lại bị lỗi (ví dụ hết phiên giữa lúc đang tải video) thì giữ trang đang có; Project đã bị xóa thì báo không tìm thấy
  const gone = q.error instanceof ApiError && q.error.status === 404;
  if (!q.data || gone) {
    return <ErrorState message={gone ? t.projects.notFound : q.error?.message} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  const fileNames = new Map(p.files.map((f) => [f.id, f.originalName]));
  const activeJobs = p.jobs.filter((j) => ACTIVE.has(j.status)).length;
  const totalActive = activeJobs + activeSttJobs + activeOverlayJobs + activeVideoJobs;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{p.name}</h1>
          {totalActive > 0 ? <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">{t.projects.running}</Badge> : null}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              {t.projects.edit}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDeleteProject(true)}>
              {t.projects.delete}
            </Button>
          </div>
        </div>
        {p.description ? <p className="max-w-3xl whitespace-pre-line text-sm text-muted-foreground">{p.description}</p> : null}
        <p className="text-xs text-muted-foreground">
          {t.projects.createdAt} {fx.dateTime(p.createdAt)}
        </p>
      </div>

      <SttActiveBanner projectId={p.id} onOpen={() => setTab('jobs')} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="files">
            {t.projects.tabFiles} ({p.files.length})
          </TabsTrigger>
          <TabsTrigger value="media">
            {t.projects.tabMedia} ({completedSttCount})
          </TabsTrigger>
          <TabsTrigger value="jobs">
            {t.projects.tabJobs} ({p.jobs.length + (sttJobs.data?.length ?? 0)})
          </TabsTrigger>
          <TabsTrigger value="voices">
            {t.projects.tabVoices} ({p.voices.length})
          </TabsTrigger>
          <TabsTrigger value="overlay">
            {t.overlay.tab} ({overlayJobs.data?.length ?? 0})
            {activeOverlayJobs > 0 ? <Badge variant="secondary">{fmt(t.overlay.runningCount, { n: activeOverlayJobs })}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="video">
            {t.video.tab} ({videoJobs.data?.length ?? 0})
            {activeVideoJobs > 0 ? <Badge variant="secondary">{fmt(t.video.runningCount, { n: activeVideoJobs })}</Badge> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="space-y-4">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Cột trái: Upload kịch bản & Editor kịch bản */}
            <div className="space-y-4 lg:col-span-7 xl:col-span-7">
              <div className="flex items-center justify-between ">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">{t.files.createNewTitle}</h2>
                </div>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setImportMediaOpen(true)}>
                  <Import className="size-4" />
                  {t.projects.importFromMedia}
                </Button>
              </div>
              {/* Khung màu xanh lá cây: Upload file kịch bản */}
              <UploadDropzone projectId={p.id} onUploaded={(id) => setPreviewId(id)} />

              {/* Khung màu vàng: Editor kịch bản chuẩn .srt / .txt / .md */}
              <ScriptEditor projectId={p.id} onCreated={(id) => setPreviewId(id)} />
            </div>

            {/* Cột phải: Danh sách file kịch bản (Khung màu đỏ theo mô tả) */}
            <div className="space-y-3 lg:col-span-5 xl:col-span-5">
              <div className="flex items-center justify-between pb-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">{t.files.scriptListTitle}</h2>
                  <Badge variant="secondary">{p.files.length}</Badge>
                </div>
              </div>

              {p.files.length === 0 ? (
                <EmptyState title={t.files.empty} />
              ) : (
                <ul className="space-y-2.5 max-h-[820px] overflow-y-auto pr-1">
                  {p.files.map((f) => (
                    <li key={f.id} className='p-1'>
                      <Card className="transition-colors hover:border-muted-foreground/40">
                        <CardContent className="flex flex-col gap-3 p-4">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setPreviewId(f.id)}
                                className="cursor-pointer truncate text-left font-medium transition-colors hover:text-primary hover:underline"
                                title={f.originalName}
                              >
                                {f.originalName}
                              </button>
                              <Badge variant="outline">.{f.ext}</Badge>
                              {f.hasTimecodes ? (
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                                  {t.files.hasTimecodes}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {f.segmentCount} {t.files.segments} · {f.charCount} {t.files.chars} · {fmtBytes(f.sizeBytes)} · {fx.dateTime(f.createdAt)}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
                            <Button size="sm" variant="outline" className="h-7 text-xs px-2.5" onClick={() => setPreviewId(f.id)}>
                              {t.files.preview}
                            </Button>
                            <Button asChild size="sm" variant="outline" className="h-7 text-xs px-2.5">
                              <a href={`/api/files/${f.id}/raw`} download>
                                {t.files.download}
                              </a>
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs px-2.5" onClick={() => setDeleteFile(f)}>
                              {t.files.delete}
                            </Button>
                            <Button size="sm" className="h-7 text-xs px-2.5 ml-auto" onClick={() => setStartFileId(f.id)}>
                              {t.files.createVoice}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="media" className="space-y-4">
          <MediaTab
            projectId={p.id}
            onGoToJobs={() => setTab('jobs')}
            onPreviewSubtitle={(id) => setPreviewId(id)}
            onImportToScript={(id) => {
              setTab('files');
              setPreviewId(id);
            }}
          />
        </TabsContent>

        <TabsContent value="jobs" className="space-y-6">
          {/* Tiến trình phiên âm Video/Audio (STT) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t.projects.sttJobsTitle}</h2>
              <Badge variant="secondary">{sttJobs.data?.length ?? 0}</Badge>
            </div>
            <Card>
              <CardContent className="p-4">
                <SttJobList projectId={p.id} onOpenResult={(id) => setPreviewId(id)} />
              </CardContent>
            </Card>
          </div>

          {/* Tiến trình tạo Voice (TTS) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t.projects.ttsJobsTitle}</h2>
              <Badge variant="secondary">{p.jobs.length}</Badge>
            </div>
            <JobTable
              projectId={p.id}
              providerType={p.providerType}
              jobs={p.jobs}
              fileNames={fileNames}
              onPreviewFile={(id) => setPreviewId(id)}
            />
          </div>
        </TabsContent>

        <TabsContent value="voices">
          {p.voices.length === 0 ? (
            <EmptyState title={t.voices.empty} />
          ) : (
            <ul className="space-y-2">
              {p.voices.map((v) => (
                <li key={v.id}>
                  <Card
                    className="cursor-pointer transition-colors hover:bg-accent/40"
                    onClick={() => router.push(`/projects/${p.id}/voices/${v.id}`)}
                  >
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium transition-colors hover:text-primary">
                          {v.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t.voices.duration} {fmtDuration(v.durationMs)} · {fmtBytes(v.sizeBytes)} · {fx.dateTime(v.createdAt)}
                        </p>
                      </div>
                      <Button asChild size="sm" onClick={(e) => e.stopPropagation()}>
                        <Link href={`/projects/${p.id}/voices/${v.id}`}>{t.voices.open}</Link>
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
        <TabsContent value="overlay">
          <OverlayTab
            projectId={p.id}
            files={p.files}
            voices={p.voices}
            onGoToScripts={() => setTab('files')}
            onCreateVoice={() => {
              const file = p.files.find((f) => f.hasTimecodes) ?? p.files[0];
              if (file) setStartFileId(file.id);
            }}
          />
        </TabsContent>
        <TabsContent value="video">
          <VideoTab projectId={p.id} />
        </TabsContent>
      </Tabs>

      <EditProjectDialog project={editOpen ? p : null} onClose={() => setEditOpen(false)} />
      <ConfirmDialog
        open={deleteProject}
        onOpenChange={setDeleteProject}
        title={t.projects.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{p.name}</p>
            <p>{t.projects.deleteDesc}</p>
          </>
        }
        confirmLabel={t.projects.delete}
        onConfirm={async () => {
          try {
            await apiDelete(`/api/projects/${p.id}`);
            toast.success(t.projects.deleted);
            await qc.invalidateQueries({ queryKey: ['projects'] });
            router.push('/projects');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : t.common.genericError);
          }
        }}
      />
      <FilePreviewDialog fileId={previewId} onClose={() => setPreviewId(null)} />
      <ImportMediaDialog
        projectId={p.id}
        open={importMediaOpen}
        onClose={() => setImportMediaOpen(false)}
        onSelectFile={(id) => {
          setTab('files');
          setPreviewId(id);
        }}
      />
      <StartJobDialog projectId={p.id} providerType={p.providerType} files={p.files} openFileId={startFileId} onClose={() => setStartFileId(null)} />
      <ConfirmDialog
        open={!!deleteFile}
        onOpenChange={(o) => !o && setDeleteFile(null)}
        title={t.files.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{deleteFile?.originalName}</p>
            <p>{t.files.deleteDesc}</p>
          </>
        }
        confirmLabel={t.files.delete}
        onConfirm={async () => {
          if (!deleteFile) return;
          try {
            await apiDelete(`/api/files/${deleteFile.id}`);
            toast.success(t.files.deleted);
            await qc.invalidateQueries({ queryKey: ['project', projectId] });
          } catch (e) {
            toast.error(e instanceof Error ? e.message : t.common.genericError);
          }
        }}
      />
    </div>
  );
}
