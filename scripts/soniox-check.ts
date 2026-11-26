/**
 * Cổng kiểm chứng T041 của spec 006: gọi Soniox THẬT đúng một lần (CÓ PHÍ) để đối chiếu kết quả dịch một chiều với tài liệu:
 * thứ tự cụm token, `translation_status: none`, giới hạn ngữ cảnh với từ điển ở mức tối đa mặc định (200 cặp, 8.000 ký tự).
 * Chỉ chạy khi người dùng đồng ý, với video khoảng 3 phút tiếng Anh hoặc Nhật:
 *
 *   npx tsx --env-file=.env scripts/soniox-check.ts <đường-dẫn-video> --co-phi
 *
 * Khóa lấy từ biến môi trường SPIKE_SONIOX_KEY và không bao giờ được in ra. Kết quả thô ghi vào tmp/soniox-check.json (không đưa vào
 * git). Dữ liệu ở Soniox được xóa trước khi kết thúc.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAudioToMp3File } from '../src/lib/audio/ffmpeg';
import { SonioxSttClient } from '../src/lib/providers/adapters/soniox';
import { SONIOX_DEFAULT_BASE_URL, SONIOX_DEFAULT_MODEL, type SonioxToken } from '../src/lib/providers/adapters/soniox-types';
import { createSafeFetch } from '../src/lib/security/safe-fetch';
import { SETTING_DEFAULTS } from '../src/lib/settings-defaults';
import { segmentCues, toClusters } from '../src/lib/video/segmentation';

/** Từ điển giả đúng mức tối đa mặc định: đo xem ngữ cảnh đóng gói có vừa giới hạn của nhà cung cấp không. */
function fullGlossary(): Array<{ source: string; target: string }> {
  const pairs = SETTING_DEFAULTS.videoGlossaryMaxPairs;
  const perSide = Math.floor(SETTING_DEFAULTS.videoGlossaryMaxChars / pairs / 2);
  return Array.from({ length: pairs }, (_, i) => ({
    source: `term ${String(i).padStart(4, '0')} `.padEnd(perSide, 'x'),
    target: `thuật ngữ ${i} `.padEnd(perSide, 'y'),
  }));
}

/** Dãy trạng thái dịch đã gộp liên tiếp, ví dụ "original×4 translation×5 …". */
function runs(tokens: SonioxToken[]): string[] {
  const out: Array<{ status: string; n: number }> = [];
  for (const t of tokens) {
    const status = t.is_audio_event ? 'event' : (t.translation_status ?? 'absent');
    const last = out.at(-1);
    if (last?.status === status) last.n++;
    else out.push({ status, n: 1 });
  }
  return out.map((r) => `${r.status}×${r.n}`);
}

async function main() {
  const [video, flag] = process.argv.slice(2);
  const apiKey = process.env.SPIKE_SONIOX_KEY;
  if (!video || flag !== '--co-phi') {
    console.error('Cách dùng: npx tsx --env-file=.env scripts/soniox-check.ts <video> --co-phi   (lần gọi này CÓ PHÍ)');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('Thiếu biến môi trường SPIKE_SONIOX_KEY');
    process.exit(1);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'soniox-check-'));
  const client = new SonioxSttClient({ config: { baseUrl: SONIOX_DEFAULT_BASE_URL, apiKey }, fetch: createSafeFetch({ allowInsecure: false, timeoutMs: 10 * 60_000 }) });
  let fileId: string | null = null;
  let transcriptionId: string | null = null;
  try {
    const audio = path.join(dir, 'audio.mp3');
    await extractAudioToMp3File(video, audio);
    const bytes = readFileSync(audio);
    console.log(`Âm thanh: ${(bytes.length / 1048576).toFixed(2)} MB`);
    ({ fileId } = await client.uploadAudioFile(bytes, 'check.mp3'));
    const terms = fullGlossary();
    console.log(`Từ điển: ${terms.length} cặp, ${terms.reduce((n, p) => n + p.source.length + p.target.length, 0)} ký tự, JSON ${JSON.stringify({ translation_terms: terms }).length} ký tự`);
    ({ transcriptionId } = await client.startTranscription(fileId, {
      model: SONIOX_DEFAULT_MODEL,
      enableLanguageIdentification: true,
      enableSpeakerDiarization: true,
      translation: { targetLanguage: 'vi' },
      translationTerms: terms,
    }));
    let state = await client.getTranscription(transcriptionId);
    while (state.status === 'queued' || state.status === 'processing') {
      await new Promise((r) => setTimeout(r, 3000));
      state = await client.getTranscription(transcriptionId);
    }
    if (state.status !== 'completed') throw new Error(`Trạng thái ${state.status}: ${state.error_type ?? ''} ${state.error_message ?? ''}`);
    const { tokens } = await client.getTranscript(transcriptionId);
    mkdirSync('tmp', { recursive: true });
    writeFileSync('tmp/soniox-check.json', JSON.stringify({ state, tokens }, null, 1));

    const clusters = toClusters(tokens);
    const cues = segmentCues(tokens, { durationMs: state.audio_duration_ms ?? Number.MAX_SAFE_INTEGER });
    const timed = tokens.filter((t) => t.translation_status === 'translation' && (t.start_ms || t.end_ms));
    console.log(`Thời lượng: ${state.audio_duration_ms} ms; ${tokens.length} token`);
    console.log(`Dãy trạng thái (40 dãy đầu): ${runs(tokens).slice(0, 40).join(' ')}`);
    console.log(`Token dịch có mốc thời gian: ${timed.length}`);
    console.log(`Cụm: ${clusters.length}; đã đúng ngôn ngữ đích: ${clusters.filter((c) => c.sameLanguage).length}; chưa dịch: ${clusters.filter((c) => c.untranslated).length}`);
    console.log(`Cue: ${cues.length}; mốc ước lượng: ${cues.filter((c) => c.timing === 'estimated').length}`);
    for (const c of cues.slice(0, 5)) console.log(`  ${c.startMs}–${c.endMs} ${c.sourceText} → ${c.targetText.replace('\n', ' / ')}`);
  } finally {
    if (transcriptionId) await client.deleteTranscription(transcriptionId).catch(() => console.error('Chưa xóa được bản phiên âm ở Soniox'));
    if (fileId) await client.deleteFile(fileId).catch(() => console.error('Chưa xóa được tệp ở Soniox'));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
