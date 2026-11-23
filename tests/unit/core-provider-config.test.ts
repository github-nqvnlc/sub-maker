import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretHint } from '@/lib/security/crypto';
import { SHOPAIKEY_TYPES } from '@/lib/providers/config-service';
import { isRealtimeModel, SONIOX_MODELS } from '@/lib/providers/adapters/soniox-types';
import { sttConfigInputSchema } from '@/lib/stt/config';

describe('cấu hình core provider 1 token (spec 004, US4)', () => {
  it('khóa API mã hóa AES-256-GCM và chỉ lộ dạng che', () => {
    const key = 'sk-soniox-secret-ABCD1234';
    const enc = encryptSecret(key);
    expect(enc.toString('utf8')).not.toContain(key);
    expect(decryptSecret(enc)).toBe(key);
    expect(secretHint(key)).not.toContain('secret');
  });

  it('ShopAIKey: một token cho cả hai adapter (OpenAI TTS, MiniMax)', () => {
    expect([...SHOPAIKEY_TYPES].sort()).toEqual(['shopaikey_minimax', 'shopaikey_openai']);
  });

  it('Soniox: model real-time không được làm mặc định cho tạo phụ đề (FR-010)', () => {
    expect(isRealtimeModel('stt-rt-v6')).toBe(true);
    expect(isRealtimeModel('stt-async-v6')).toBe(false);
    expect(SONIOX_MODELS.find((m) => m.id === 'stt-async-v5')?.legacy).toBe(true);
    expect(sttConfigInputSchema.safeParse({ apiKey: 'x', unknown: 1 }).success).toBe(false);
  });
});
