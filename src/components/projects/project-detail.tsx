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
import { fmtBytes, fmtDateTime, fmtDuration } from '@/lib/format';
import { vi } from '@/lib/i18n/vi';

type FileDto = { id: string; originalName: string; ext: string; sizeBytes: number; charCount: number; segmentCount: number; createdAt: string };
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
    return <ErrorState message={q.error instanceof ApiError && q.error.status === 404 ? vi.projects.notFound : q.error.message} onRetry={() => void q.refetch()} />;
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
          {activeJobs > 0 ? <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-300">{vi.projects.running}</Badge> : null}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              {vi.projects.edit}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDeleteProject(true)}>
              {vi.projects.delete}
            </Button>
          </div>
        </div>
        {p.description ? <p className="max-w-3xl whitespace-pre-line text-sm text-muted-foreground">{p.description}</p> : null}
        <p className="text-xs text-muted-foreground">
          {vi.projects.createdAt} {fmtDateTime(p.createdAt)}
        </p>
      </div>

      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">
            {vi.projects.tabFiles} ({p.files.length})
          </TabsTrigger>
          <TabsTrigger value="jobs">
            {vi.projects.tabJobs} ({p.jobs.length})
          </TabsTrigger>
          <TabsTrigger value="voices">
            {vi.projects.tabVoices} ({p.voices.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="space-y-4">
          <UploadDropzone projectId={p.id} onUploaded={(id) => setPreviewId(id)} />
          {p.files.length === 0 ? (
            <EmptyState title={vi.files.empty} />
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
                          {f.segmentCount} {vi.files.segments} · {f.charCount} {vi.files.chars} · {fmtBytes(f.sizeBytes)} · {fmtDateTime(f.createdAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setPreviewId(f.id)}>
                          {vi.files.preview}
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <a href={`/api/files/${f.id}/raw`} download>
                            {vi.files.download}
                          </a>
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDeleteFile(f)}>
                          {vi.files.delete}
                        </Button>
                        <Button size="sm" onClick={() => setStartFileId(f.id)}>
                          {vi.files.createVoice}
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
            <EmptyState title={vi.voices.empty} />
          ) : (
            <ul className="space-y-2">
              {p.voices.map((v) => (
                <li key={v.id}>
                  <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{v.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {vi.voices.duration} {fmtDuration(v.durationMs)} · {fmtBytes(v.sizeBytes)} · {fmtDateTime(v.createdAt)}
                        </p>
                      </div>
                      <Button asChild size="sm">
                        <Link href={`/projects/${p.id}/voices/${v.id}`}>{vi.voices.open}</Link>
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
        title={vi.projects.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{p.name}</p>
            <p>{vi.projects.deleteDesc}</p>
          </>
        }
        confirmLabel={vi.projects.delete}
        onConfirm={async () => {
          try {
            await apiDelete(`/api/projects/${p.id}`);
            toast.success(vi.projects.deleted);
            await qc.invalidateQueries({ queryKey: ['projects'] });
            router.push('/projects');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : vi.common.genericError);
          }
        }}
      />
      <FilePreviewDialog fileId={previewId} onClose={() => setPreviewId(null)} />
      <StartJobDialog projectId={p.id} providerType={p.providerType} files={p.files} openFileId={startFileId} onClose={() => setStartFileId(null)} />
      <ConfirmDialog
        open={!!deleteFile}
        onOpenChange={(o) => !o && setDeleteFile(null)}
        title={vi.files.deleteTitle}
        description={
          <>
            <p className="font-medium text-foreground">{deleteFile?.originalName}</p>
            <p>{vi.files.deleteDesc}</p>
          </>
        }
        confirmLabel={vi.files.delete}
        onConfirm={async () => {
          if (!deleteFile) return;
          try {
            await apiDelete(`/api/files/${deleteFile.id}`);
            toast.success(vi.files.deleted);
            await qc.invalidateQueries({ queryKey: ['project', projectId] });
          } catch (e) {
            toast.error(e instanceof Error ? e.message : vi.common.genericError);
          }
        }}
      />
    </div>
  );
}
