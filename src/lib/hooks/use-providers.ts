'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export type ProviderVoice = { id: string; label: string; gender: string; region: string };
export type ProviderInfo = {
  type: string;
  label: string;
  available: boolean;
  usingOwnConfig: boolean;
  models: { id: string; label: string; voices: ProviderVoice[] }[];
  speed: { min: number; max: number; default: number; step: number };
  maxCharsPerRequest: number;
};

/** Danh mục nhà cung cấp + khả dụng cho User hiện tại (dùng ở biểu mẫu tạo Project và bắt đầu tạo voice). */
export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: () => api<ProviderInfo[]>('/api/providers'), staleTime: 30_000 });
}
