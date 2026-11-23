import type { PgBoss } from 'pg-boss';
import { registerDeleteUser } from './jobs/delete-user';
import { registerGenerateVoice } from './jobs/generate-voice';
import { registerReconcileStorage } from './jobs/reconcile-storage';
import { registerTranscribeMedia } from './jobs/transcribe-media';

/**
 * Đăng ký các trình xử lý hàng đợi. Mỗi user story thêm trình xử lý của mình tại đây:
 *  - US7: delete-user
 *  - US1/US2: generate-voice (+ sweeper)
 *  - US8: reconcile-storage
 *  - spec 004: transcribe-media (STT Soniox, + sweeper)
 */
export type HandlerRegistrar = (boss: PgBoss) => Promise<void> | void;

export const registrars: HandlerRegistrar[] = [registerDeleteUser, registerGenerateVoice, registerReconcileStorage, registerTranscribeMedia];

export async function registerHandlers(boss: PgBoss): Promise<void> {
  for (const register of registrars) await register(boss);
}
