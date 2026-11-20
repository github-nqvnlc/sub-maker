import type { InferSelectModel } from 'drizzle-orm';
import type { projects, subtitleFiles, voiceJobs, voices } from '../db/schema';

/** Chuyển bản ghi DB sang DTO theo contracts/openapi.yaml (không lộ trường nội bộ). */

export type ProjectRow = InferSelectModel<typeof projects>;
export type FileRow = InferSelectModel<typeof subtitleFiles>;
export type JobRow = InferSelectModel<typeof voiceJobs>;
export type VoiceRow = InferSelectModel<typeof voices>;

export const projectDto = (p: ProjectRow) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  providerType: p.providerType,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const fileDto = (f: FileRow) => ({
  id: f.id,
  originalName: f.originalName,
  ext: f.ext,
  sizeBytes: f.sizeBytes,
  charCount: f.charCount,
  segmentCount: f.segmentCount,
  hasTimecodes: f.hasTimecodes,
  cueCount: f.cueCount,
  durationMs: f.durationMs,
  warningCount: f.cueWarningCount,
  createdAt: f.createdAt.toISOString(),
});

export const jobDto = (j: JobRow, voiceId: string | null = null) => ({
  id: j.id,
  projectId: j.projectId,
  fileId: j.subtitleFileId,
  status: j.status,
  providerType: j.providerType,
  configScope: j.configScope,
  settings: {
    model: j.settings.model ?? null,
    voice: j.settings.voice,
    speed: j.settings.speed ?? null,
    timing: j.settings.timing ? { mode: j.settings.timing.mode, mergeCues: j.settings.timing.mergeCues } : null,
  },
  progressDone: j.progressDone,
  progressTotal: j.progressTotal,
  errorCode: j.errorCode,
  errorMessage: j.errorMessage,
  voiceId,
  createdAt: j.createdAt.toISOString(),
  startedAt: j.startedAt?.toISOString() ?? null,
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

export const voiceDto = (v: VoiceRow) => ({
  id: v.id,
  title: v.title,
  durationMs: v.durationMs,
  sizeBytes: v.sizeBytes,
  createdAt: v.createdAt.toISOString(),
});
