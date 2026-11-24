import { decryptSecret } from '../security/crypto';
import { createSafeFetch } from '../security/safe-fetch';
import { allowInsecure, getConfigRow } from './config-service';
import { SONIOX_TTS_VOICES } from './catalog';
import { getSttConfigRow } from '../stt/config';

export type SonioxVoiceOption = {
  id: string;
  label: string;
  isCustom?: boolean;
};

export async function fetchSonioxVoices(
  userId?: string,
  options?: { apiKey?: string; fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }
): Promise<SonioxVoiceOption[]> {
  let apiKey: string | null = options?.apiKey ?? null;

  // Kiểm tra cấu hình riêng của User nếu có
  if (!apiKey && userId) {
    const personal = await getConfigRow('user', userId, 'soniox').catch(() => null);
    if (personal && personal.enabled && personal.apiKeyEnc) {
      apiKey = decryptSecret(personal.apiKeyEnc);
    }
  }

  // Cấu hình chung AI
  if (!apiKey) {
    const global = await getConfigRow('global', null, 'soniox').catch(() => null);
    if (global && global.enabled && global.apiKeyEnc) {
      apiKey = decryptSecret(global.apiKeyEnc);
    }
  }

  // Cấu hình Soniox dùng chung (đã nhập ở cài đặt)
  if (!apiKey) {
    const stt = await getSttConfigRow().catch(() => null);
    if (stt && stt.enabled && stt.apiKeyEnc) {
      apiKey = decryptSecret(stt.apiKeyEnc);
    }
  }

  const defaultList: SonioxVoiceOption[] = SONIOX_TTS_VOICES.map((v) => ({
    id: v.id,
    label: v.label,
    isCustom: false,
  }));

  if (!apiKey) {
    return defaultList;
  }

  const safeFetch = options?.fetchFn ?? createSafeFetch({ allowInsecure: allowInsecure() });
  const customVoices: SonioxVoiceOption[] = [];
  const sharedVoices: SonioxVoiceOption[] = [];

  // 1. Lấy danh sách giọng tùy chỉnh / clone trên Console của người dùng
  try {
    const res = await safeFetch('https://api.soniox.com/v1/voices', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { voices?: Array<{ id?: string; voice_id?: string; name?: string }> };
      if (Array.isArray(data.voices)) {
        for (const v of data.voices) {
          const id = v.id || v.voice_id;
          if (id) {
            customVoices.push({
              id,
              label: `${v.name || id} (Console)`,
              isCustom: true,
            });
          }
        }
      }
    }
  } catch {}

  // 2. Lấy danh sách giọng chuẩn từ Soniox
  try {
    const res = await safeFetch('https://api.soniox.com/v1/shared-voices?model=tts-rt-v2', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { voices?: Array<{ id?: string; voice_id?: string; name?: string; gender?: string }> };
      if (Array.isArray(data.voices) && data.voices.length > 0) {
        for (const v of data.voices) {
          const id = v.id || v.voice_id;
          if (id) {
            const genderLabel = v.gender === 'female' ? 'Nữ' : v.gender === 'male' ? 'Nam' : '';
            sharedVoices.push({
              id,
              label: `${v.name || id}${genderLabel ? ` (${genderLabel})` : ''}`,
              isCustom: false,
            });
          }
        }
      }
    }
  } catch {}

  const finalShared = sharedVoices.length > 0 ? sharedVoices : defaultList;
  return [...customVoices, ...finalShared];
}
