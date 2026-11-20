'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState, ErrorState, LoadingList } from '@/components/shared/states';
import { StartJobDialog } from '@/components/jobs/start-job-dialog';
import { EditProjectDialog } from '@/components/projects/edit-project-dialog';
import { FilePreviewDialog } from '@/components/projects/file-preview-dialog';
import { JobTable, type JobRowDto } from '@/components/projects/job-table';
import { UploadDropzone } from '@/components/projects/upload-dropzone';
import { ApiError, api, apiDelete } from '@/lib/api-client';
import { fmtBytes, fmtDuration } from '@/lib/format';
import { useFormat, useT } from '@/lib/i18n/client';

type FileDto = { id: string; originalName: string; ext: string; sizeBytes: number; charCount: number; segmentCount: number; hasTimecodes?: boolean; cueCount?: number | null; durationMs?: number | null; createdAt: string };
type VoiceDto = { id: string; title: string; durationMs: number; sizeBytes: number; createdAt: string };
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

export function ProjectDetail({ projectId }: { projectId: string }) {
  const t = useT();
  const fx = useFormat();
  const qc = useQueryClient();
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteProject, setDeleteProject] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [startFileId, setStartFileId] = useState<string | null>(null);
  const [deleteFile, setDeleteFile] = useState<FileDto | null>(null);

  const q = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetailDto>(`/api/projects/${projectId}`),
    // Cập nhật định kỳ khi còn tiến trình đang chạy (FR-002)
    refetchInterval: (query) => (query.state.data?.jobs.some((j) => ACTIVE.has(j.status)) ? 3000 : false),
  });

  if (q.isPending) return <LoadingList rows={4} />;
  if (q.isError) {
    return <ErrorState message={q.error instanceof ApiError && q.error.status === 404 ? t.projects.notFound : q.error.message} onRetry={() => void q.refetch()} />;
  }
  const p = q.data;
  const fileNames = new Map(p.files.map((f) => [f.id, f.originalName]));
  const activeJobs = p.jobs.filter((j) => ACTIVE.has(j.status)).length;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{p.name}</h1>
          <Badge variant="secondary">{p.providerType}</Badge>
          {activeJobs > 0 ? <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">{t.projects.running}</Badge> : null}
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

      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">
            {t.projects.tabFiles} ({p.files.length})
          </TabsTrigger>
          <TabsTrigger value="jobs">
            {t.projects.tabJobs} ({p.jobs.length})
          </TabsTrigger>
          <TabsTrigger value="voices">
            {t.projects.tabVoices} ({p.voices.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="space-y-4">
          <UploadDropzone projectId={p.id} onUploaded={(id) => setPreviewId(id)} />
          {p.files.length === 0 ? (
            <EmptyState title={t.files.empty} />
          ) : (
            <ul className="space-y-2">
              {p.files.map((f) => (
                <li key={f.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{f.originalName}</span>
                          <Badge variant="outline">.{f.ext}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {f.segmentCount} {t.files.segments} · {f.charCount} {t.files.chars} · {fmtBytes(f.sizeBytes)} · {fx.dateTime(f.createdAt)}
                          {f.hasTimecodes ? ` · ${t.files.hasTimecodes}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setPreviewId(f.id)}>
                          {t.files.preview}
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <a href={`/api/files/${f.id}/raw`} download>
                            {t.files.download}
                          </a>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDeleteFile(f)}>
                          {t.files.delete}
                        </Button>
                        <Button size="sm" onClick={() => setStartFileId(f.id)}>
                          {t.files.createVoice}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="jobs">
          <JobTable projectId={p.id} providerType={p.providerType} jobs={p.jobs} fileNames={fileNames} />
        </TabsContent>

        <TabsContent value="voices">
          {p.voices.length === 0 ? (
            <EmptyState title={t.voices.empty} />
          ) : (
            <ul className="space-y-2">
              {p.voices.map((v) => (
                <li key={v.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{v.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.voices.duration} {fmtDuration(v.durationMs)} · {fmtBytes(v.sizeBytes)} · {fx.dateTime(v.createdAt)}
                        </p>
                      </div>
                      <Button asChild size="sm">
                        <Link href={`/projects/${p.id}/voices/${v.id}`}>{t.voices.open}</Link>
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
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
