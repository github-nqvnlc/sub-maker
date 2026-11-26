import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRange, serveObject } from '@/lib/storage/proxy';

const store = vi.hoisted(() => ({ size: 100 * 1024 * 1024, calls: [] as Array<{ range?: string; signal?: AbortSignal }>, controller: null as ReadableStreamDefaultController<Uint8Array> | null }));
vi.mock('@/lib/storage/client', () => ({
  headObject: async () => ({ size: store.size }),
  getObjectRange: async (_key: string, range?: string, signal?: AbortSignal) => {
    store.calls.push({ range, signal });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        store.controller = c;
      },
    });
    return { Body: { transformToWebStream: () => stream } };
  },
}));
import { assertKeyOwnedBy, storageKeys } from '@/lib/storage/keys';

describe('parseRange', () => {
  it('không có header hoặc không hiểu → null (trả toàn bộ)', () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
  });

  it('bytes=start-end', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-999', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('bytes=start- (đến hết) và end vượt quá kích thước bị cắt', () => {
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('suffix: n byte cuối', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('không thỏa mãn → unsatisfiable (416)', () => {
    expect(parseRange('bytes=1000-1100', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=500-100', 1000)).toBe('unsatisfiable');
  });
});

describe('serveObject: video (spec 006, T017)', () => {
  afterEach(() => {
    vi.useRealTimers();
    store.calls.length = 0;
  });
  const MB8 = 8 * 1024 * 1024;

  it('truyền signal cho lệnh đọc kho, cả dải lẫn toàn bộ', async () => {
    const signal = new AbortController().signal;
    await serveObject('k', { contentType: 'video/mp4', rangeHeader: 'bytes=0-9', signal });
    await serveObject('k', { contentType: 'video/mp4', signal });
    expect(store.calls.map((c) => c.signal)).toEqual([signal, signal]);
  });

  it('dải mở bị giới hạn khi đặt maxOpenRange; dải có điểm cuối và yêu cầu không dải giữ nguyên', async () => {
    const open = await serveObject('k', { contentType: 'video/mp4', rangeHeader: 'bytes=1000-', maxOpenRange: MB8 });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe(`bytes 1000-${1000 + MB8 - 1}/${store.size}`);
    expect(open.headers.get('content-length')).toBe(String(MB8));
    const tail = await serveObject('k', { contentType: 'video/mp4', rangeHeader: `bytes=${store.size - 10}-`, maxOpenRange: MB8 });
    expect(tail.headers.get('content-length')).toBe('10');
    const closed = await serveObject('k', { contentType: 'video/mp4', rangeHeader: `bytes=0-${MB8 * 2}`, maxOpenRange: MB8 });
    expect(closed.headers.get('content-length')).toBe(String(MB8 * 2 + 1));
    const unlimited = await serveObject('k', { contentType: 'video/mp4', rangeHeader: 'bytes=0-' });
    expect(unlimited.headers.get('content-length')).toBe(String(store.size));
  });

  it('giữ thẻ: gọi ngay khi mở, rồi mỗi 60 giây khi luồng còn chạy; dừng khi đọc xong', async () => {
    vi.useFakeTimers();
    const beat = vi.fn(async () => undefined);
    const res = await serveObject('k', { contentType: 'video/mp4', onStreaming: beat });
    expect(beat).toHaveBeenCalledTimes(1);
    const reader = res.body!.getReader();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(beat).toHaveBeenCalledTimes(3);
    store.controller!.enqueue(new Uint8Array([1, 2]));
    store.controller!.close();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    expect((await reader.read()).done).toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('giữ thẻ: dừng khi trình duyệt hủy tải hoặc kho lỗi', async () => {
    vi.useFakeTimers();
    for (const end of ['cancel', 'error'] as const) {
      const beat = vi.fn(async () => undefined);
      const res = await serveObject('k', { contentType: 'video/mp4', onStreaming: beat });
      const reader = res.body!.getReader();
      if (end === 'cancel') await reader.cancel();
      else {
        store.controller!.error(new Error('mất kết nối kho'));
        await expect(reader.read()).rejects.toThrow('mất kết nối kho');
      }
      await vi.advanceTimersByTimeAsync(180_000);
      expect(beat).toHaveBeenCalledTimes(1);
    }
  });
});

describe('storageKeys', () => {
  it('mọi khóa nằm dưới users/{id}/', () => {
    const uid = '11111111-1111-1111-1111-111111111111';
    for (const k of [
      storageKeys.subtitleOriginal(uid, 'f1'),
      storageKeys.audioCache(uid, 'abc'),
      storageKeys.voice(uid, 'v1'),
      storageKeys.avatar(uid),
      storageKeys.videoSource(uid, 'j1', 'mkv'),
      storageKeys.videoExport(uid, 'j1', 'e1', 'mp4'),
      storageKeys.videoAudio(uid, 'j1'),
      storageKeys.videoClientAudio(uid, 'j1', 'm4a'),
      storageKeys.videoPreview(uid, 'j1'),
      storageKeys.videoTranscript(uid, 'j1', 2),
    ]) {
      expect(k.startsWith(storageKeys.userPrefix(uid))).toBe(true);
      expect(() => assertKeyOwnedBy(k, uid)).not.toThrow();
    }
  });

  it('khóa video đúng data-model §5: tệp tính hạn mức dưới video/, tệp tạm dưới video-tmp/', () => {
    expect(storageKeys.videoSource('u', 'j', 'mkv')).toBe('users/u/video/j/source.mkv');
    expect(storageKeys.videoExport('u', 'j', 'e', 'mov')).toBe('users/u/video/j/exports/e.mov');
    expect(storageKeys.videoAudio('u', 'j')).toBe('users/u/video-tmp/j/audio.mp3');
    expect(storageKeys.videoClientAudio('u', 'j', 'webm')).toBe('users/u/video-tmp/j/audio-client.webm');
    expect(storageKeys.videoPreview('u', 'j')).toBe('users/u/video-tmp/j/preview.mp4');
    expect(storageKeys.videoTranscript('u', 'j', 3)).toBe('users/u/video-tmp/j/transcript-3.json');
    expect(storageKeys.videoJobPrefix('u', 'j')).toBe('users/u/video/j/');
    expect(storageKeys.videoJobTempPrefix('u', 'j')).toBe('users/u/video-tmp/j/');
    expect(storageKeys.videoPrefix('u')).toBe('users/u/video/');
    expect(storageKeys.videoTempPrefix('u')).toBe('users/u/video-tmp/');
  });

  it('từ chối khóa của người khác hoặc có ..', () => {
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(() => assertKeyOwnedBy(storageKeys.avatar(b), a)).toThrow();
    expect(() => assertKeyOwnedBy(`users/${a}/../${b}/avatar`, a)).toThrow();
  });
});
