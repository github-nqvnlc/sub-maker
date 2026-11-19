import { JobMonitor } from '@/components/jobs/job-monitor';

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <JobMonitor jobId={jobId} />;
}
