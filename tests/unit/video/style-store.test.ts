import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIDEO_STYLE, type VideoStyle } from '@/lib/video/style';
import { StyleStore } from '@/lib/video/style-store';

/** Tự lưu kiểu phụ đề (spec 006, T099; FR-031): hiện ngay, gửi bản mới nhất, không gửi chồng nhau. */

const base = (): VideoStyle => structuredClone(DEFAULT_VIDEO_STYLE);
const sized = (size: number): VideoStyle => ({ ...base(), font: { ...base().font, size } });

function harness() {
  const sent: VideoStyle[] = [];
  const waiting: Array<{ ok: () => void; fail: (e: Error) => void }> = [];
  const store = new StyleStore({
    style: base(),
    delayMs: 500,
    save: (style) => {
      sent.push(style);
      return new Promise<void>((resolve, reject) => waiting.push({ ok: resolve, fail: reject }));
    },
  });
  return { store, sent, waiting };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('StyleStore', () => {
  it('đổi là hiện ngay; chỉ gửi bản mới nhất sau khi ngừng chỉnh', async () => {
    const { store, sent, waiting } = harness();
    store.set(sized(50));
    expect(store.getSnapshot()).toMatchObject({ status: 'pending', style: { font: { size: 50 } } });
    await vi.advanceTimersByTimeAsync(300);
    store.set(sized(52));
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((s) => s.font.size)).toEqual([52]);
    expect(store.getSnapshot().status).toBe('saving');
    waiting[0]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: 'saved', savedVersion: 1 });
  });

  it('đổi trong lúc đang gửi: gửi tiếp bản mới sau khi lượt trước xong, không chồng nhau', async () => {
    const { store, sent, waiting } = harness();
    store.set(sized(50));
    await vi.advanceTimersByTimeAsync(500);
    store.set(sized(60));
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(1);
    waiting[0]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.font.size)).toEqual([50, 60]);
    expect(store.getSnapshot().status).toBe('saving');
    waiting[1]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: 'saved', savedVersion: 2 });
  });

  it('giá trị không đổi thì không gửi; tổ hợp không hợp lệ được chuẩn hóa ngay', async () => {
    const { store, sent } = harness();
    store.set(base());
    expect(store.getSnapshot().status).toBe('saved');
    store.set({ ...base(), sync: 'karaoke', wordEffect: 'none' });
    expect(store.getSnapshot().style.wordEffect).toBe('active');
    await vi.advanceTimersByTimeAsync(500);
    expect(sent[0]!.wordEffect).toBe('active');
  });

  it('lưu lỗi: giữ thay đổi, báo lỗi, thử lại gửi đúng bản mới nhất', async () => {
    const { store, sent, waiting } = harness();
    store.set(sized(50));
    await vi.advanceTimersByTimeAsync(500);
    waiting[0]!.fail(new Error('mất mạng'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'mất mạng', style: { font: { size: 50 } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
    store.retry();
    expect(sent).toHaveLength(2);
    // dải báo lỗi còn nguyên trong lúc thử lại
    expect(store.getSnapshot()).toMatchObject({ status: 'saving', error: 'mất mạng' });
    waiting[1]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: 'saved', error: null });
  });

  it('sau lỗi, chỉnh tiếp thì tự gửi lại', async () => {
    const { store, sent, waiting } = harness();
    store.set(sized(50));
    await vi.advanceTimersByTimeAsync(500);
    waiting[0]!.fail(new Error('x'));
    await vi.advanceTimersByTimeAsync(0);
    store.set(sized(51));
    expect(store.getSnapshot().status).toBe('pending');
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.map((s) => s.font.size)).toEqual([50, 51]);
  });

  it('flush gửi ngay và đợi tới khi lưu xong; lỗi thì trả false', async () => {
    const { store, sent, waiting } = harness();
    await expect(store.flush()).resolves.toBe(true);
    store.set(sized(50));
    const done = store.flush();
    expect(sent).toHaveLength(1);
    store.set(sized(55));
    waiting[0]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    waiting[1]!.ok();
    await expect(done).resolves.toBe(true);
    expect(sent.map((s) => s.font.size)).toEqual([50, 55]);

    store.set(sized(60));
    const failed = store.flush();
    waiting[2]!.fail(new Error('x'));
    await expect(failed).resolves.toBe(false);
  });

  it('bản từ máy chủ chỉ được nhận khi người dùng chưa chỉnh gì', async () => {
    const { store, waiting } = harness();
    store.adopt(sized(70));
    expect(store.getSnapshot()).toMatchObject({ status: 'saved', style: { font: { size: 70 } } });
    store.set(sized(40));
    await vi.advanceTimersByTimeAsync(500);
    waiting[0]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    store.adopt(sized(70));
    expect(store.getSnapshot().style.font.size).toBe(40);
  });

  it('rời trang: gửi nốt thay đổi đang chờ', async () => {
    const { store, sent } = harness();
    store.set(sized(50));
    store.dispose();
    expect(sent.map((s) => s.font.size)).toEqual([50]);
  });

  it('rời trang sau một lượt lỗi: thử gửi lại một lần', async () => {
    const { store, sent, waiting } = harness();
    store.set(sized(50));
    await vi.advanceTimersByTimeAsync(500);
    waiting[0]!.fail(new Error('x'));
    await vi.advanceTimersByTimeAsync(0);
    store.dispose();
    expect(sent.map((s) => s.font.size)).toEqual([50, 50]);
    waiting[1]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toMatchObject({ status: 'saved', error: null });
  });
});
