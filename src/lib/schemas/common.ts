import { z } from 'zod';
import { vi } from '../i18n/vi';
import { isCommonPassword } from '../security/common-passwords';

export const providerTypeSchema = z.enum(['fpt_marketplace', 'shopaikey_openai', 'shopaikey_minimax']);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const jobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'stopped', 'interrupted']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const uuidSchema = z.string().uuid();

export const idsBodySchema = z.object({
  ids: z.array(uuidSchema).min(1).max(100),
});

/** Chính sách mật khẩu: 10–128 ký tự, không toàn chữ số, không thuộc danh sách phổ biến. */
export const passwordSchema = z
  .string()
  .min(10, vi.validation.passwordMin)
  .max(128, vi.validation.passwordMax)
  .refine((v) => !/^\d+$/.test(v), vi.validation.passwordAllDigits)
  .refine((v) => !isCommonPassword(v), vi.validation.passwordCommon);

export const displayNameSchema = z.string().trim().min(1, vi.validation.nameLength).max(60, vi.validation.nameLength);
export const bioSchema = z.string().max(500, vi.validation.bioLength);

export const projectNameSchema = z
  .string()
  .refine((v) => v.trim().length >= 1 && [...v].length <= 120, vi.validation.projectName);
export const projectDescriptionSchema = z.string().refine((v) => [...v].length <= 2000, vi.validation.projectDescription);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
