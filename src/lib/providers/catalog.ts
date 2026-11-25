import type { ModelInfo, ProviderCatalog, ProviderType, VoiceInfo } from './types';
import { SONIOX_MODELS } from './adapters/soniox-types';

/**
 * Danh mục model/giọng/tốc độ theo từng nhà cung cấp (nguồn: docs/fpt-ai-voice-guide.md, docs/shopaikey-guide.md).
 * Các giá trị đánh dấu ⚠️ trong tài liệu (khoảng speed của Marketplace, giới hạn ký tự) dùng mặc định thận trọng
 * cho đến khi Spike S1–S3 xác nhận (docs/provider-spikes.md).
 */

const v = (id: string, label: string, gender: VoiceInfo['gender'], region: VoiceInfo['region'] = ''): VoiceInfo => ({
  id,
  label,
  gender,
  region,
});

const FPT_MARKETPLACE_VOICES: Record<string, VoiceInfo[]> = {
  'FPT.AI-VITs': [
    v('banmai', 'Ban Mai (nữ, miền Bắc)', 'female', 'north'),
    v('thuminh', 'Thu Minh (nữ, miền Bắc)', 'female', 'north'),
    v('leminh', 'Lê Minh (nam, miền Bắc)', 'male', 'north'),
    v('minhquan', 'Minh Quân (nam, miền Bắc)', 'male', 'north'),
    v('ngoclam', 'Ngọc Lam (nữ, miền Trung)', 'female', 'central'),
    v('giahuy', 'Gia Huy (nam, miền Trung)', 'male', 'central'),
    v('kimngan', 'Kim Ngân (nữ, miền Nam)', 'female', 'south'),
    v('hatieumai', 'Hà Tiểu Mai (nữ, miền Nam)', 'female', 'south'),
    v('huyphong', 'Huy Phong (nam, miền Nam)', 'male', 'south'),
  ],
  'FPT.TTS-pro': [
    v('std_banmai', 'Ban Mai (nữ, miền Bắc)', 'female', 'north'),
    v('std_quanganh', 'Quang Anh (nam, miền Bắc)', 'male', 'north'),
    v('fci_phuongan', 'Phương An (nữ)', 'female'),
    v('fci_vietkhoa', 'Việt Khoa (nam)', 'male'),
    v('fci_xuantoan', 'Xuân Toàn (nam)', 'male'),
  ],
  'FPT.TTS-ultra': [
    v('std_banmai', 'Ban Mai (nữ, miền Bắc)', 'female', 'north'),
    v('std_kimngan', 'Kim Ngân (nữ, miền Nam)', 'female', 'south'),
    v('std_quanganh', 'Quang Anh (nam, miền Bắc)', 'male', 'north'),
    v('std_minhquang', 'Minh Quang (nam)', 'male'),
    v('std_vietkhoa', 'Việt Khoa (nam)', 'male'),
    v('fci_phuongan', 'Phương An (nữ)', 'female'),
    v('fci_xuantoan', 'Xuân Toàn (nam)', 'male'),
  ],
};

const FPT_MARKETPLACE: ProviderCatalog = {
  type: 'fpt_marketplace',
  label: 'FPT.AI',
  defaultBaseUrl: 'https://mkp-api.fptcloud.com/v1',
  models: Object.entries(FPT_MARKETPLACE_VOICES).map(
    ([id, voices]): ModelInfo => ({
      id,
      label: id,
      voices,
    }),
  ),
  // Hệ số tốc độ (khác thang của FPT Speech). Đã kiểm chứng bằng khóa thật (S3, 2026-11-19): 0,25–4 được chấp nhận, 5 trở lên bị 422.
  speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
  // Đã kiểm chứng (S3): 1.500 ký tự được chấp nhận, 10.001 bị 422. Giữ 5.000 làm giới hạn an toàn (đoạn thực tế ≤ 400 ký tự).
  maxCharsPerRequest: 5000,
  minChars: 1,
  // Theo docs/fpt.ai: gói Thường (FPT.AI-VITs) ~30 yêu cầu/phút/khóa; dùng làm mức chung cho cả nhà cung cấp (thận trọng).
  requestsPerMinute: 30,
};

const OPENAI_VOICES: VoiceInfo[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((id) =>
  v(id, id.charAt(0).toUpperCase() + id.slice(1), 'neutral'),
);

const SHOPAIKEY_OPENAI: ProviderCatalog = {
  type: 'shopaikey_openai',
  label: 'ShopAIKey (OpenAI TTS)',
  defaultBaseUrl: 'https://api.shopaikey.com',
  models: [{ id: 'tts-1', label: 'tts-1', voices: OPENAI_VOICES }],
  speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
  maxCharsPerRequest: 4096,
  minChars: 1,
};

// Giọng tiếng Việt của MiniMax (nguồn: GET /tts/minimax/voices của ShopAIKey, 2026-11-19). Giới tính suy ra từ tên giọng;
// vùng miền theo mô tả ("giọng Bắc"/"giọng Nam"), để trống khi mô tả không nêu rõ.
const MINIMAX_VOICES: VoiceInfo[] = [
  v('Vietnamese_Professional_Guide_v6', 'Nam Hướng Dẫn', 'male', 'north'),
  v('Vietnamese_Serene_Man', 'Nam Trầm Ấm', 'male'),
  v('Vietnamese_Professional_Narrator_v2', 'Nam Dẫn Chuyện', 'male', 'north'),
  v('Vietnamese_female_4_v1', 'Nữ Tự Tin', 'female'),
  v('Vietnamese_Articulate_Assistant_v1', 'Nữ Trợ Lý', 'female', 'south'),
  v('Vietnamese_male_1_v2', 'Nam Năng Động', 'male'),
  v('Vietnamese_Warm_Narrator_v1', 'Nam Ấm Áp', 'male', 'north'),
  v('Vietnamese_kindhearted_girl', 'Nữ Tốt Bụng', 'female'),
  v('Vietnamese_Steady_Instructor_v1', 'Nam Giảng Viên', 'male', 'north'),
  v('Vietnamese_polished_Announcer_v3', 'Nữ Thông Báo', 'female', 'north'),
  v('Vietnamese_patient_Instructor_v1', 'Nữ Kiên Nhẫn', 'female', 'north'),
  v('Vietnamese_crisp_announcer_v2', 'Nữ Sắc Nét', 'female', 'north'),
  v('Vietnamese_Professional_Assistant_v1', 'Nữ Đáng Tin', 'female', 'north'),
  v('Vietnamese_Podcast_Host_v2', 'Nam Podcast', 'male', 'north'),
  v('Vietnamese_Audiobook_woman_v2', 'Nữ Sách Nói', 'female', 'north'),
  v('Vietnamese_Male_Narrator_v1', 'Nam Động Viên', 'male', 'south'),
  v('Vietnamese_Cheerful_Instructor_v1', 'Nam Vui Vẻ', 'male', 'north'),
  v('Vietnamese_Cute_Girl_v1', 'Nữ Dễ Thương', 'female', 'north'),
];

// Model chạy được với khóa thật (2026-11-19). Không đưa speech-2.8-* vì ShopAIKey đang trả lỗi 500 (proxy không đọc được phản hồi nén).
const MINIMAX_MODELS = ['speech-02-hd', 'speech-02-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-01-hd', 'speech-01-turbo'];

const SHOPAIKEY_MINIMAX: ProviderCatalog = {
  type: 'shopaikey_minimax',
  label: 'ShopAIKey',
  defaultBaseUrl: 'https://api.shopaikey.com',
  models: [
    { id: 'tts-1', label: 'tts-1 (OpenAI TTS)', voices: OPENAI_VOICES },
    { id: 'tts-1-hd', label: 'tts-1-hd (OpenAI TTS chất lượng cao)', voices: OPENAI_VOICES },
    ...MINIMAX_MODELS.map((id): ModelInfo => ({ id, label: id, voices: MINIMAX_VOICES })),
  ],
  // Nhận speed 0.25–4 cho OpenAI và 0.5–2 cho MiniMax; 0.25–4 là thang hợp lệ chung
  speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
  // Tài liệu MiniMax: tối đa 10.000 ký tự; dùng 5.000 làm giới hạn an toàn (đoạn thực tế ≤ 400).
  maxCharsPerRequest: 5000,
  minChars: 1,
};

const OPENAI_SDK_VOICES: VoiceInfo[] = [
  v('alloy', 'Alloy (Trung tính)', 'neutral'),
  v('echo', 'Echo (Nam)', 'male'),
  v('fable', 'Fable (Nam)', 'male'),
  v('onyx', 'Onyx (Nam trầm)', 'male'),
  v('nova', 'Nova (Nữ)', 'female'),
  v('shimmer', 'Shimmer (Nữ ấm)', 'female'),
  v('ash', 'Ash (Nam tự nhiên)', 'male'),
  v('ballad', 'Ballad (Nam ấm áp)', 'male'),
  v('coral', 'Coral (Nữ tươi sáng)', 'female'),
  v('sage', 'Sage (Nữ tự nhiên)', 'female'),
  v('verse', 'Verse (Nữ biểu cảm)', 'female'),
];

const OPENAI_COMPATIBLE_MODELS: ModelInfo[] = [
  { id: 'tts-1', label: 'tts-1 (TTS tiêu chuẩn)', voices: OPENAI_SDK_VOICES },
  { id: 'tts-1-hd', label: 'tts-1-hd (TTS chất lượng cao)', voices: OPENAI_SDK_VOICES },
  { id: 'gpt-4o-mini-audio-preview', label: 'gpt-4o-mini-audio-preview (TTS Audio Preview)', voices: OPENAI_SDK_VOICES },
  { id: 'gpt-4o-audio-preview', label: 'gpt-4o-audio-preview (TTS Audio Preview)', voices: OPENAI_SDK_VOICES },
  { id: 'whisper-1', label: 'whisper-1 (STT Speech-to-Text)', voices: OPENAI_SDK_VOICES },
];

const OPENAI_COMPATIBLE: ProviderCatalog = {
  type: 'openai_compatible',
  label: 'Nhà cung cấp AI tùy chỉnh',
  defaultBaseUrl: 'https://api.openai.com/v1',
  models: OPENAI_COMPATIBLE_MODELS,
  speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
  maxCharsPerRequest: 4096,
  minChars: 1,
};

export const SONIOX_TTS_VOICES: VoiceInfo[] = [
  { id: 'Daniel', label: 'Daniel (Nam, tự nhiên/đàm thoại)', gender: 'male', region: '' },
  { id: 'Adrian', label: 'Adrian (Nam, chuyên nghiệp/trầm)', gender: 'male', region: '' },
  { id: 'Emily', label: 'Emily (Nữ, ấm áp/thân thiện)', gender: 'female', region: '' },
  { id: 'Emma', label: 'Emma (Nữ, tự nhiên/rõ ràng)', gender: 'female', region: '' },
  { id: 'Nina', label: 'Nina (Nữ, biểu cảm)', gender: 'female', region: '' },
  { id: 'Sophia', label: 'Sophia (Nữ, năng động)', gender: 'female', region: '' },
  { id: 'Oliver', label: 'Oliver (Nam, điềm đạm)', gender: 'male', region: '' },
  { id: 'Lucas', label: 'Lucas (Nam, trẻ trung)', gender: 'male', region: '' },
  { id: 'Mia', label: 'Mia (Nữ, nhẹ nhàng)', gender: 'female', region: '' },
  { id: 'Arjun', label: 'Arjun (Nam, mạch lạc)', gender: 'male', region: '' },
];

const SONIOX: ProviderCatalog = {
  type: 'soniox',
  label: 'Soniox',
  defaultBaseUrl: 'https://tts-rt.soniox.com',
  models: [
    { id: 'tts-rt-v2', label: 'tts-rt-v2 (Text-to-Speech v2)', voices: SONIOX_TTS_VOICES },
    ...SONIOX_MODELS.map((m) => ({ id: m.id, label: `${m.id} (STT)`, voices: [] })),
  ],
  speed: { min: 0.7, max: 1.3, default: 1, step: 0.05 },
  maxCharsPerRequest: 5000,
  minChars: 1,
};

const CATALOGS: Record<ProviderType, ProviderCatalog> = {
  fpt_marketplace: FPT_MARKETPLACE,
  soniox: SONIOX,
  shopaikey_minimax: SHOPAIKEY_MINIMAX,
  shopaikey_openai: SHOPAIKEY_OPENAI,
  openai_compatible: OPENAI_COMPATIBLE,
};

export const PROVIDER_TYPES = Object.keys(CATALOGS) as ProviderType[];

export function getCatalog(type: ProviderType): ProviderCatalog {
  return CATALOGS[type];
}

export function allCatalogs(): ProviderCatalog[] {
  return [FPT_MARKETPLACE, SONIOX, SHOPAIKEY_MINIMAX, OPENAI_COMPATIBLE];
}

export type ResolvedSettings = { model: string | null; voice: string; speed: number | null };

export type SettingsInput = {
  model?: string | null;
  voice?: string | null;
  speed?: number | null;
  /** Giá trị mặc định của cấu hình nhà cung cấp (nếu có). */
  defaults?: { model?: string | null; voice?: string | null; speed?: number | null };
};

/**
 * Chuẩn hóa và kiểm tra thiết lập (model/giọng/tốc độ) theo catalog của nhà cung cấp.
 * Trả `{ ok:false, fields }` với thông điệp tiếng Việt theo trường.
 */
export function resolveSettings(
  type: ProviderType,
  input: SettingsInput,
): { ok: true; value: ResolvedSettings } | { ok: false; fields: Record<string, string> } {
  if (type === 'soniox') {
    const model = input.model ?? input.defaults?.model ?? 'tts-rt-v2';
    const voice = input.voice ?? input.defaults?.voice ?? 'Daniel';
    const speed = input.speed ?? input.defaults?.speed ?? 1.0;
    return { ok: true, value: { model, voice, speed } };
  }
  const cat = getCatalog(type);
  const fields: Record<string, string> = {};

  const model = input.model ?? input.defaults?.model ?? cat.models[0]!.id;
  const modelInfo = cat.models.find((m) => m.id === model);
  if (!modelInfo && type !== 'openai_compatible') {
    fields.model = 'Model không được hỗ trợ cho nhà cung cấp này';
  }

  const voice = input.voice ?? input.defaults?.voice ?? modelInfo?.voices[0]?.id ?? (type === 'openai_compatible' ? 'alloy' : null);
  if (type !== 'openai_compatible' && modelInfo && (!voice || !modelInfo.voices.some((x) => x.id === voice))) {
    fields.voice = 'Giọng đọc không có trong model đã chọn';
  } else if (!voice) {
    fields.voice = 'Giọng đọc không được để trống';
  }

  const speed: number | null = input.speed ?? input.defaults?.speed ?? cat.speed.default;
  if (speed !== null) {
    if (!Number.isFinite(speed) || speed < cat.speed.min || speed > cat.speed.max) {
      fields.speed = `Tốc độ phải từ ${cat.speed.min} đến ${cat.speed.max}`;
    }
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { model: model ?? null, voice: voice!, speed } };
}
