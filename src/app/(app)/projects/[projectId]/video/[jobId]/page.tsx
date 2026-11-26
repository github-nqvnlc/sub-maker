import { VideoEditor } from '@/components/video/editor';

export default async function VideoJobPage({ params }: { params: Promise<{ projectId: string; jobId: string }> }) {
  const { projectId, jobId } = await params;
  // key theo jobId để chuyển giữa các việc làm mới hoàn toàn trình phát và lịch sử hoàn tác
  return <VideoEditor key={jobId} projectId={projectId} jobId={jobId} />;
}
