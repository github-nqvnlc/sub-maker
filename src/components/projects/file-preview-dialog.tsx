'use client';

import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { api } from '@/lib/api-client';
import { vi } from '@/lib/i18n/vi';

type FileDetail = {
  id: string;
  originalName: string;
  segmentCount: number;
  charCount: number;
  rawText: string;
  segments: { idx: number; text: string; charCount: number }[];
};

/** Xem trước các đoạn sẽ được đọc (FR-011) và văn bản gốc của tệp (FR-010). */
export function FilePreviewDialog({ fileId, onClose }: { fileId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['file', fileId],
    enabled: !!fileId,
    queryFn: () => api<FileDetail>(`/api/files/${fileId}`),
  });

  return (
    <Dialog open={!!fileId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{q.data?.originalName ?? vi.files.previewTitle}</DialogTitle>
          <DialogDescription>
            {q.data ? `${q.data.segmentCount} ${vi.files.segments} · ${q.data.charCount} ${vi.files.chars}. ` : ''}
            {vi.files.previewDesc}
          </DialogDescription>
        </DialogHeader>
        {q.isPending ? (
          <LoadingList rows={4} />
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (
          <Tabs defaultValue="segments">
            <TabsList>
              <TabsTrigger value="segments">{vi.files.previewTitle}</TabsTrigger>
              <TabsTrigger value="raw">{vi.files.original}</TabsTrigger>
            </TabsList>
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
