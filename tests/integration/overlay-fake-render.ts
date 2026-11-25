import { writeFile } from 'node:fs/promises';
import type { RenderHandle, RenderOutcome, SpawnRender } from '@/worker/render/spawn-render';

/** Tiến trình con giả cho kiểm thử luồng nghiệp vụ (spec 005): không dựng hình, điều khiển được kết quả và thời điểm. */
export type FakeRender = {
  spawn: SpawnRender;
  calls: number;
  cancelled: number;
  /** mở khóa lần chạy đang chờ (khi `hold` bật) */
  release: () => void;
  started: Promise<void>;
};

export function fakeRender(opts: { bytes?: number; outcomes?: Array<'ok' | Extract<RenderOutcome, { ok: false }>['code']>; hold?: boolean } = {}): FakeRender {
  const outcomes = [...(opts.outcomes ?? [])];
  let releaseAll: () => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    releaseAll = r;
  });
  const fake: FakeRender = {
    calls: 0,
    cancelled: 0,
    release: () => releaseAll(),
    started: new Promise<void>((r) => {
      markStarted = r;
    }),
    spawn: (task, hooks): RenderHandle => {
      fake.calls++;
      const outcome = outcomes.shift() ?? 'ok';
      let cancel: () => void = () => undefined;
      const aborted = new Promise<'cancel'>((r) => {
        cancel = () => {
          fake.cancelled++;
          r('cancel');
        };
      });
      const done = (async (): Promise<RenderOutcome> => {
        hooks.onProgress?.(150, 300);
        markStarted();
        if (opts.hold && (await Promise.race([gate.then(() => 'go' as const), aborted])) === 'cancel') return { ok: false, code: 'CANCELLED', detail: '' };
        if (outcome !== 'ok') return { ok: false, code: outcome, detail: '/noi/bo/bi-mat sk-secret-key-12345678' };
        const bytes = opts.bytes ?? 5000;
        await writeFile(task.outPath, Buffer.alloc(bytes, 7));
        return { ok: true, bytes };
      })();
      return { done, cancel: () => cancel(), pid: undefined };
    },
  };
  return fake;
}

/** Chạy nhanh trong kiểm thử. */
export const FAST_RENDER = { heartbeatMs: 30, admissionPollMs: 20, retry: { baseMs: 5, maxMs: 20 }, freeBytes: async () => 10 ** 13 } as const;
