'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, LoadingList } from '@/components/shared/states';
import { SyncedText, type SyncedSegment } from '@/components/player/synced-text';
import { VoicePlayer } from '@/components/player/voice-player';
import { ApiError, api } from '@/lib/api-client';
import { fmtDuration } from '@/lib/format';
import { useFormat, useT } from '@/lib/i18n/client';

type VoiceDetailDto = {
  id: string;
  title: string;
  durationMs: number;
  sizeBytes: number;
  createdAt: string;
  projectId: string;
  fileId: string;
  segments: SyncedSegment[];
};
type ProjectVoices = { voices: { id: string; title: string }[] };

/** Trang nghe voice: trình phát + văn bản đồng bộ + kịch bản gốc; chọn giữa các voice của Project (FR-002, FR-027). */
export function VoiceView({ voiceId, projectId }: { voiceId: string; projectId: string }) {
  const t = useT();
  const fx = useFormat();
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement>(null);

  const voice = useQuery({ queryKey: ['voice', voiceId], queryFn: () => api<VoiceDetailDto>(`/api/voices/${voiceId}`) });
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api<ProjectVoices>(`/api/projects/${projectId}`) });
  const raw = useQuery({
    queryKey: ['file', voice.data?.fileId],
    enabled: !!voice.data?.fileId,
    queryFn: () => api<{ rawText: string }>(`/api/files/${voice.data!.fileId}`),
  });

  if (voice.isPending) return <LoadingList rows={4} />;
  if (voice.isError) {
    return <ErrorState message={voice.error instanceof ApiError && voice.error.status === 404 ? t.voices.notFound : voice.error.message} onRetry={() => void voice.refetch()} />;
  }
  const v = voice.data;
  const others = project.data?.voices ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{v.title}</h1>
          <p className="text-sm text-muted-foreground">
            {t.voices.duration} {fmtDuration(v.durationMs)} · {fx.dateTime(v.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {others.length > 1 ? (
            <Select value={voiceId} onValueChange={(id) => router.push(`/projects/${projectId}/voices/${id}`)}>
              <SelectTrigger className="w-56" aria-label={t.voices.switchVoice}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${projectId}`}>{t.voices.backToProject}</Link>
          </Button>
        </div>
      </div>

      <VoicePlayer voiceId={v.id} durationMs={v.durationMs} audioRef={audioRef} />

      <Tabs defaultValue="synced">
        <TabsList>
          <TabsTrigger value="synced">{t.voices.synced}</TabsTrigger>
          <TabsTrigger value="original">{t.voices.original}</TabsTrigger>
        </TabsList>
        <TabsContent value="synced">
          <SyncedText audioRef={audioRef} segments={v.segments} />
        </TabsContent>
        <TabsContent value="original">
          <ScrollArea className="h-[28rem] rounded-md border">
            <pre className="whitespace-pre-wrap break-words p-4 font-sans text-sm">{raw.data?.rawText ?? t.common.loading}</pre>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
