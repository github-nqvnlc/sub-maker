import { ProjectDetail } from '@/components/projects/project-detail';

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { projectId } = await params;
  const { tab } = await searchParams;
  return <ProjectDetail projectId={projectId} initialTab={tab} />;
}
