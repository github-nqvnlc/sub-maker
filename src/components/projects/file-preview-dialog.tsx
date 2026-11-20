'use client';

import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { CuePreview } from '@/components/projects/cue-preview';
import { api } from '@/lib/api-client';
import { useT } from '@/lib/i18n/client';

type FileDetail = {
  id: string;
  originalName: string;
  segmentCount: number;
  charCount: number;
  hasTimecodes?: boolean;
  durationMs?: number | null;
  rawText: string;
  segments: { idx: number; text: string; charCount: number }[];
};

/** Xem trước các đoạn sẽ được đọc (FR-011) và văn bản gốc của tệp (FR-010). */
export function FilePreviewDialog({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const t = useT();
  const q = useQuery({
    queryKey: ['file', fileId],
    enabled: !!fileId,
    queryFn: () => api<FileDetail>(`/api/files/${fileId}`),
  });

  return (
    <Dialog open={!!fileId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{q.data?.originalName ?? t.files.previewTitle}</DialogTitle>
          <DialogDescription>
            {q.data ? `${q.data.segmentCount} ${t.files.segments} · ${q.data.charCount} ${t.files.chars}. ` : ''}
            {t.files.previewDesc}
          </DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <LoadingList rows={4} />
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (
          <Tabs defaultValue="segments">
            <TabsList>
              <TabsTrigger value="segments">{t.files.previewTitle}</TabsTrigger>
              {q.data.hasTimecodes ? <TabsTrigger value="cues">{t.files.tabCues}</TabsTrigger> : null}
              <TabsTrigger value="raw">{t.files.original}</TabsTrigger>
            </TabsList>
            {q.data.hasTimecodes ? (
              <TabsContent value="cues">
                <CuePreview fileId={q.data.id} durationMs={q.data.durationMs ?? null} />
              </TabsContent>
            ) : null}
            <TabsContent value="segments">
              <ScrollArea className="h-80 rounded-md border">
                <ol className="divide-y">
                  {q.data.segments.map((s) => (
                    <li key={s.idx} className="flex gap-3 p-3 text-sm">
                      <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{s.idx + 1}</span>
                      <span className="min-w-0 break-words">{s.text}</span>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="raw">
              <ScrollArea className="h-80 rounded-md border">
                <pre className="whitespace-pre-wrap break-words p-3 font-sans text-sm">{q.data.rawText}</pre>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
