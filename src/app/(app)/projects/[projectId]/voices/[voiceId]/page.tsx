import { VoiceView } from '@/components/player/voice-view';

export default async function VoicePage({ params }: { params: Promise<{ projectId: string; voiceId: string }> }) {
  const { projectId, voiceId } = await params;
  // key theo voiceId để chuyển giữa các voice làm mới hoàn toàn trình phát và vòng đồng bộ
  return <VoiceView key={voiceId} voiceId={voiceId} projectId={projectId} />;
}
