/**
 * Kiểu dữ liệu Soniox Speech-to-Text REST API (async). Đã đối chiếu tài liệu chính thức ngày 2026-11-23
 * (docs.soniox.com/api-reference/stt/...), xem research.md R1.
 */

/** Token mức dưới-từ: `text` có thể mang khoảng trắng đầu (ví dụ "Hel", "lo", " world"). */
export type SonioxToken = {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  /** Chỉ có khi bật enable_speaker_diarization */
  speaker?: string;
  /** Chỉ có khi bật enable_language_identification */
  language?: string;
  is_audio_event?: boolean;
  translation_status?: 'none' | 'original' | 'translation';
};

/** Tài liệu liệt kê "error"; trang Errors dùng "failed" — chấp nhận cả hai. */
export type SonioxTranscriptionStatus = 'queued' | 'processing' | 'completed' | 'error' | 'failed';

export type SonioxTranscription = {
  id: string;
  status: SonioxTranscriptionStatus;
  model?: string;
  /** Chỉ có sau khi bắt đầu xử lý */
  audio_duration_ms?: number | null;
  error_type?: string | null;
  error_message?: string | null;
};

export type SonioxTranscript = { id: string; text: string; tokens: SonioxToken[] };

export type SonioxUploadedFile = { id: string; filename: string; size: number };

export type StartTranscriptionOptions = {
  /** Model async, ví dụ `stt-async-v6`. Model real-time (`stt-rt-*`) bị từ chối trước khi gọi. */
  model: string;
  /** Mã ngôn ngữ gợi ý (FR-016); bỏ trống = tự nhận diện */
  languageHints?: string[];
  enableSpeakerDiarization?: boolean;
  enableLanguageIdentification?: boolean;
  clientReferenceId?: string;
  /** Dịch một chiều (spec 006): token dịch đi theo cụm ngay sau cụm lời gốc và KHÔNG có mốc. */
  translation?: { targetLanguage: string };
  /** Từ điển thuật ngữ gửi trong ngữ cảnh (`context.translation_terms`); chỉ là chỉ dẫn cho máy dịch. */
  translationTerms?: Array<{ source: string; target: string }>;
};

/** Model real-time không dùng được với API async (FR-010). */
export const isRealtimeModel = (model: string) => /^stt-rt-/i.test(model.trim());

export const SONIOX_DEFAULT_BASE_URL = 'https://api.soniox.com';
export const SONIOX_DEFAULT_MODEL = 'stt-async-v6';
/** Model hiển thị cho Administrator (trang Models của Soniox, 2026-11-23). `legacy` = bản cũ, `realtime` = không chọn được làm mặc định. */
export const SONIOX_MODELS: Array<{ id: string; kind: 'async' | 'realtime'; legacy?: boolean }> = [
  { id: 'stt-async-v6', kind: 'async' },
  { id: 'stt-async-v5', kind: 'async', legacy: true },
  { id: 'stt-rt-v6', kind: 'realtime' },
];
