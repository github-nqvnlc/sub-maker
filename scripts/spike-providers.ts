/**
 * Spike S1–S3: gọi THẬT từng adapter với một câu tiếng Việt, in độ trễ/kích thước/định dạng và lưu file
 * nghe thử vào tmp/spike/. Khóa lấy từ biến môi trường SPIKE_*; KHÔNG bao giờ được in ra.
 * Xem docs/provider-spikes.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getProvider } from '../src/lib/providers';
import { toProviderError } from '../src/lib/providers/errors';
import type { TtsProviderType } from '../src/lib/schemas/common';
import { createSafeFetch } from '../src/lib/security/safe-fetch';

type Target = { type: TtsProviderType; keyEnv: string; model?: string; voice: string };

const TARGETS: Target[] = [
  { type: 'fpt_marketplace', keyEnv: 'SPIKE_FPT_MARKETPLACE_KEY', model: 'FPT.AI-VITs', voice: 'banmai' },
  { type: 'shopaikey_openai', keyEnv: 'SPIKE_SHOPAIKEY_KEY', model: 'tts-1', voice: 'alloy' },
  { type: 'shopaikey_minimax', keyEnv: 'SPIKE_SHOPAIKEY_KEY', model: 'speech-02-hd', voice: 'Vietnamese_female_4_v1' },
];

const SAMPLES = {
  ngan: 'Xin chào các bạn, hôm nay chúng ta cùng tìm hiểu về lịch sử Việt Nam.',
  dai: 'Việt Nam là một quốc gia nằm ở phía đông bán đảo Đông Dương, với lịch sử hàng nghìn năm dựng nước và giữ nước. Từ thời các vua Hùng, qua các triều đại Lý, Trần, Lê, cho đến thời hiện đại, dân tộc ta luôn thể hiện tinh thần đoàn kết, kiên cường và sáng tạo. Mỗi vùng miền lại có những nét văn hóa riêng, từ chợ nổi miền Tây đến phố cổ Hà Nội, từ cố đô Huế đến những bản làng Tây Nguyên.',
};

const outDir = path.resolve(process.cwd(), 'tmp/spike');
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const safeFetch = createSafeFetch({ allowInsecure: false });
  for (const t of TARGETS) {
    const apiKey = process.env[t.keyEnv];
    const provider = getProvider(t.type);
    if (!apiKey) {
      console.log(`[${t.type}] bỏ qua: chưa đặt ${t.keyEnv}`);
      continue;
    }
    const cat = provider.catalog();
    for (const [label, text] of Object.entries(SAMPLES)) {
      const started = Date.now();
      try {
        const res = await provider.synthesize(
          { text, model: t.model, voice: t.voice },
          { config: { baseUrl: cat.defaultBaseUrl, apiKey }, fetch: safeFetch },
        );
        const ext = res.mime.includes('mpeg') ? 'mp3' : 'wav';
        const file = path.join(outDir, `${t.type}-${label}.${ext}`);
        fs.writeFileSync(file, res.audio);
        console.log(`[${t.type}] ${label}: ${Date.now() - started} ms, ${res.audio.length} byte, ${res.mime}, ${res.unitsChars} ký tự → ${file}`);
      } catch (e) {
        const pe = toProviderError(e);
        console.log(`[${t.type}] ${label}: LỖI ${pe.code}${pe.httpStatus ? ` (HTTP ${pe.httpStatus})` : ''} sau ${Date.now() - started} ms`);
      }
    }
  }
}

main().catch((e) => {
  console.error('spike thất bại:', e instanceof Error ? e.message : 'không rõ');
  process.exit(1);
});
