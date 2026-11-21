import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/lib/db';
import { aiProviderConfigs } from '../src/lib/db/schema';
import { decryptSecret } from '../src/lib/security/crypto';
import { eq } from 'drizzle-orm';
import { getProvider } from '../src/lib/providers';
import { createSafeFetch } from '../src/lib/security/safe-fetch';
import { decodeToPcm, encodeMp3 } from '../src/lib/audio/ffmpeg';

const FPT_TARGETS = [
  // FPT.AI-VITs
  { model: 'FPT.AI-VITs', id: 'banmai', text: 'Xin chào, tôi là Ban Mai, giọng đọc nữ miền Bắc trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'thuminh', text: 'Xin chào, tôi là Thu Minh, giọng đọc nữ miền Bắc trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'leminh', text: 'Xin chào, tôi là Lê Minh, giọng đọc nam miền Bắc trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'minhquan', text: 'Xin chào, tôi là Minh Quân, giọng đọc nam miền Bắc trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'ngoclam', text: 'Xin chào, tôi là Ngọc Lam, giọng đọc nữ miền Trung trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'giahuy', text: 'Xin chào, tôi là Gia Huy, giọng đọc nam miền Trung trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'kimngan', text: 'Xin chào, tôi là Kim Ngân, giọng đọc nữ miền Nam trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'hatieumai', text: 'Xin chào, tôi là Hà Tiểu Mai, giọng đọc nữ miền Nam trên Sub Maker.' },
  { model: 'FPT.AI-VITs', id: 'huyphong', text: 'Xin chào, tôi là Huy Phong, giọng đọc nam miền Nam trên Sub Maker.' },
  // FPT.TTS-pro & FPT.TTS-ultra (khi key có quyền truy cập gói Pro / Ultra)
  { model: 'FPT.TTS-pro', id: 'std_banmai', text: 'Xin chào, tôi là Ban Mai, giọng đọc chất lượng cao trên Sub Maker.' },
  { model: 'FPT.TTS-pro', id: 'std_quanganh', text: 'Xin chào, tôi là Quang Anh, giọng đọc nam miền Bắc trên Sub Maker.' },
  { model: 'FPT.TTS-pro', id: 'fci_phuongan', text: 'Xin chào, tôi là Phương An, giọng đọc nữ trên Sub Maker.' },
  { model: 'FPT.TTS-pro', id: 'fci_vietkhoa', text: 'Xin chào, tôi là Việt Khoa, giọng đọc nam trên Sub Maker.' },
  { model: 'FPT.TTS-pro', id: 'fci_xuantoan', text: 'Xin chào, tôi là Xuân Toàn, giọng đọc nam trên Sub Maker.' },
  { model: 'FPT.TTS-ultra', id: 'std_kimngan', text: 'Xin chào, tôi là Kim Ngân, giọng đọc chất lượng cao trên Sub Maker.' },
  { model: 'FPT.TTS-ultra', id: 'std_minhquang', text: 'Xin chào, tôi là Minh Quang, giọng đọc nam trên Sub Maker.' },
];

async function main() {
  const db = getDb();
  const [cfg] = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.type, 'fpt_marketplace')).limit(1);
  let apiKey = '';
  let baseUrl = 'https://mkp-api.fptcloud.com/v1';

  if (cfg) {
    apiKey = decryptSecret(cfg.apiKeyEnc);
    baseUrl = cfg.baseUrl;
  } else if (process.env.SPIKE_FPT_MARKETPLACE_KEY) {
    apiKey = process.env.SPIKE_FPT_MARKETPLACE_KEY;
  }

  if (!apiKey) {
    console.error('Không tìm thấy API key của FPT Marketplace');
    process.exit(1);
  }

  const outDir = path.resolve(process.cwd(), 'public/previews/fpt');
  fs.mkdirSync(outDir, { recursive: true });

  const provider = getProvider('fpt_marketplace');
  const safeFetch = createSafeFetch({ allowInsecure: true });

  console.log(`Bắt đầu tạo preview audio cho ${FPT_TARGETS.length} giọng FPT...`);

  for (const v of FPT_TARGETS) {
    const started = Date.now();
    try {
      console.log(`Đang tạo giọng [${v.model} - ${v.id}]...`);
      const res = await provider.synthesize(
        { text: v.text, model: v.model, voice: v.id },
        { config: { baseUrl, apiKey }, fetch: safeFetch }
      );

      // Chuyển sang MP3 128kbps để nhẹ và tương thích tốt trên mọi trình duyệt
      const pcm = await decodeToPcm(res.audio);
      const mp3 = await encodeMp3(pcm, 128);

      const filePath = path.join(outDir, `${v.id}.mp3`);
      fs.writeFileSync(filePath, mp3);
      console.log(`  ✓ Thành công: ${v.id}.mp3 (${mp3.length} bytes, ${(Date.now() - started)}ms)`);
      // Nghỉ 1s giữa các request để tránh rate limit
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`  ✗ Lỗi giọng ${v.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('Hoàn thành tạo audio preview FPT!');
  process.exit(0);
}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
