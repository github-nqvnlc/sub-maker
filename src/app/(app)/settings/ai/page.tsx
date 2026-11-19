import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { AiConfigManager } from '@/components/settings/ai-config-manager';
import { getCurrentUser } from '@/lib/auth/guards';

export const dynamic = 'force-dynamic';

/** Chỉ User trong danh sách "dùng AI riêng" thấy trang này; người khác nhận 404 (FR-043). */
export default async function PersonalAiPage() {
  const user = await getCurrentUser(await headers());
  if (!user || !user.canUseCustomAi) notFound();
  return <AiConfigManager scope="user" />;
}
