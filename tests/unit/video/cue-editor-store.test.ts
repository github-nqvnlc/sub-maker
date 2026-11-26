import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { CueEditorStore, RETRY_MS, SAVE_DELAY_MS } from '@/lib/video/cue-editor-store';
import { mergeOps, type CueBatch } from '@/lib/video/cue-ops';
import { formatCueTime, parseCueTime } from '@/lib/video/time';
import type { Cue } from '@/lib/video/types';

/** Tự lưu sau 800 ms, hoàn tác và làm lại, xung đột (spec 006, T067; FR-023, FR-024). */

const cue = (id: string, startMs: number, endMs: number, targetText = `đích ${id}`): Cue => ({ id, startMs, endMs, timing: 'measured', sourceText: `source ${id}`, targetText, sourceLang: 'en', speaker: '1', flags: {} });
const base = (): Cue[] => [cue('a', 0, 1000), cue('b', 2000, 3000)];
const text = (id: string, targetText: string) => ({ type: 'update' as const, id, patch: { targetText } });

function setup(save: (b: CueBatch) => Promise<{ revision: number }> = async (b) => ({ revision: b.baseRevision + 1 })) {
  const sent: CueBatch[] = [];
  const store = new CueEditorStore({
    cues: base(),
    revision: 1,
    durationMs: 10_000,
    save: (b) => {
      sent.push(structuredClone(b));
      return save(b);
    },
  });
  return { store, sent, snap: () => store.getSnapshot() };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const idle = (ms = SAVE_DELAY_MS) => vi.advanceTimersByTimeAsync(ms);

describe('tự lưu', () => {
  it('đổi ngay trên màn hình, gửi một lô sau 800 ms yên lặng, gộp các lần gõ liên tiếp', async () => {
    const { store, sent, snap } = setup();
    expect(snap()).toMatchObject({ status: 'saved', canUndo: false, revision: 1 });
    expect(store.apply([text('a', 'x')], { merge: 'a:target' })).toBeNull();
    expect(snap().cues[0]!.targetText).toBe('x');
    expect(snap().status).toBe('dirty');
    await idle(500);
    store.apply([text('a', 'xy')], { merge: 'a:target' });
    await idle(500);
    expect(sent).toHaveLength(0);
    await idle(300);
    expect(sent).toEqual([{ baseRevision: 1, ops: [text('a', 'xy')] }]);
    expect(snap()).toMatchObject({ status: 'saved', revision: 2 });
  });

  it('thao tác không hợp lệ trả về cue vi phạm và không đổi gì', async () => {
    const { store, sent, snap } = setup();
    expect(store.apply([{ type: 'update', id: 'a', patch: { endMs: 2500 } }])).toEqual({ id: 'a', reason: 'overlap' });
    expect(snap()).toMatchObject({ status: 'saved', canUndo: false });
    await idle();
    expect(sent).toHaveLength(0);
  });

  it('sửa trong lúc đang gửi thì gửi tiếp lô sau với phiên bản mới', async () => {
    let release!: (v: { revision: number }) => void;
    let first = true;
    const { store, sent, snap } = setup((b) => {
      if (!first) return Promise.resolve({ revision: b.baseRevision + 1 });
      first = false;
      return new Promise((r) => (release = r));
    });
    store.apply([text('a', 'một')], { merge: 'a:target' });
    await idle();
    expect(snap().status).toBe('saving');
    store.apply([text('a', 'một hai')], { merge: 'a:target' });
    await idle();
    expect(sent).toHaveLength(1); // chưa xong lô đầu thì chưa gửi lô hai
    release({ revision: 2 });
    await idle();
    expect(sent[1]).toEqual({ baseRevision: 2, ops: [text('a', 'một hai')] });
    expect(snap()).toMatchObject({ status: 'saved', revision: 3 });
  });

  it('lỗi mạng: giữ thay đổi, tự thử lại, hoặc thử ngay khi người dùng bấm', async () => {
    let fail = 2;
    const { store, sent, snap } = setup(async (b) => {
      if (fail-- > 0) throw new TypeError('Failed to fetch');
      return { revision: b.baseRevision + 1 };
    });
    store.apply([text('a', 'x')]);
    await idle();
    expect(snap()).toMatchObject({ status: 'error', revision: 1 });
    await idle(RETRY_MS);
    expect(sent).toHaveLength(2);
    expect(snap().status).toBe('error');
    store.retry();
    await idle(0);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual({ baseRevision: 1, ops: [text('a', 'x')] });
    expect(snap().status).toBe('saved');
  });

  it.each(['CUE_CONFLICT', 'CUE_INVALID', 'VIDEO_NOT_EDITABLE', 'NOT_FOUND'])('máy chủ từ chối (%s): dừng lưu, đòi tải lại; tải lại bỏ thay đổi chưa lưu', async (code) => {
    const { store, sent, snap } = setup(async () => {
      throw new ApiError(code === 'NOT_FOUND' ? 404 : 409, code, 'thông báo');
    });
    store.apply([text('a', 'x')]);
    await idle();
    expect(snap()).toMatchObject({ status: 'conflict', error: { code, message: 'thông báo' } });
    expect(store.apply([text('b', 'y')])).toBeNull();
    expect(snap().cues[1]!.targetText).toBe('đích b'); // không nhận thêm thay đổi
    store.undo();
    await idle(RETRY_MS);
    expect(sent).toHaveLength(1);
    store.reset(base(), 7);
    expect(snap()).toMatchObject({ status: 'saved', revision: 7, canUndo: false, error: null });
    expect(snap().cues[0]!.targetText).toBe('đích a');
  });

  it('flush gửi ngay; dispose gửi nốt phần chưa lưu', async () => {
    const { store, sent } = setup();
    store.apply([text('a', 'x')]);
    await store.flush();
    expect(sent).toHaveLength(1);
    store.apply([text('b', 'y')]);
    store.dispose();
    await idle(0);
    expect(sent).toHaveLength(2);
  });

  it('rời trang khi lưu đang lỗi: vẫn thử lại tới khi được; máy chủ từ chối thì báo mất thay đổi', async () => {
    let fail = 1;
    const warned: boolean[] = [];
    const kept = new CueEditorStore({
      cues: base(),
      revision: 1,
      durationMs: 10_000,
      save: async (b) => {
        if (fail-- > 0) throw new TypeError('Failed to fetch');
        return { revision: b.baseRevision + 1 };
      },
      onLost: (_e, retrying) => warned.push(retrying),
    });
    fail = 2;
    kept.apply([text('a', 'x')]);
    kept.dispose();
    await idle(0);
    expect(kept.getSnapshot()).toMatchObject({ status: 'error', error: { code: 'NETWORK' } });
    await idle(RETRY_MS);
    await idle(RETRY_MS);
    expect(kept.getSnapshot()).toMatchObject({ status: 'saved', error: null });
    expect(warned).toEqual([true]);

    const lost: unknown[] = [];
    const store = new CueEditorStore({
      cues: base(),
      revision: 1,
      durationMs: 10_000,
      save: async () => {
        throw new ApiError(409, 'CUE_CONFLICT', 'đã đổi');
      },
      onLost: (e) => lost.push(e),
    });
    store.apply([text('a', 'x')]);
    store.dispose();
    await idle(0);
    expect(lost).toEqual([{ code: 'CUE_CONFLICT', message: 'đã đổi' }]);
  });

  it('dữ liệu mới hơn từ máy chủ chỉ được nhận khi không còn gì chưa lưu', async () => {
    const { store, snap } = setup();
    expect(store.adopt([cue('a', 0, 1000, 'cũ')], 1)).toBe(false);
    store.apply([text('a', 'x')]);
    expect(store.adopt([cue('a', 0, 1000, 'tab khác')], 5)).toBe(false);
    await idle();
    expect(store.adopt([cue('a', 0, 1000, 'tab khác')], 5)).toBe(true);
    expect(snap()).toMatchObject({ revision: 5, canUndo: false });
    expect(snap().cues[0]!.targetText).toBe('tab khác');
  });
});

describe('hoàn tác và làm lại', () => {
  it('một chuỗi gõ liên tiếp hoàn tác một lần; nghỉ lâu hoặc ô khác thì là bước mới', async () => {
    const { store, snap } = setup();
    store.apply([text('a', 'x')], { merge: 'a:target' });
    store.apply([text('a', 'xy')], { merge: 'a:target' });
    await idle(3000);
    store.apply([text('a', 'xyz')], { merge: 'a:target' });
    store.apply([text('b', 'q')], { merge: 'b:target' });
    store.undo();
    expect(snap().cues.map((c) => c.targetText)).toEqual(['xyz', 'đích b']);
    store.undo();
    expect(snap().cues[0]!.targetText).toBe('xy');
    store.undo();
    expect(snap().cues[0]!.targetText).toBe('đích a');
    expect(snap()).toMatchObject({ canUndo: false, canRedo: true });
    store.redo();
    expect(snap().cues[0]!.targetText).toBe('xy');
    store.apply([text('b', 'mới')]);
    expect(snap().canRedo).toBe(false);
  });

  it('hoàn tác sau khi đã lưu gửi thao tác ngược lên máy chủ', async () => {
    const { store, sent, snap } = setup();
    store.apply(mergeOps(snap().cues, 'a')!);
    await idle();
    expect(snap().cues).toHaveLength(1);
    store.undo();
    expect(snap().cues).toEqual(base());
    await idle();
    expect(sent[1]!.baseRevision).toBe(2);
    expect(sent[1]!.ops.map((o) => o.type)).toEqual(['insert', 'update']);
  });
});

describe('mốc thời gian dạng chữ', () => {
  it('hiện giờ:phút:giây.phần nghìn, bỏ giờ khi chưa tới một giờ', () => {
    expect(formatCueTime(0)).toBe('00:00.000');
    expect(formatCueTime(83_045)).toBe('01:23.045');
    expect(formatCueTime(3_600_000 + 5_007)).toBe('1:00:05.007');
  });
  it.each([
    ['01:23.045', 83_045],
    ['1:00:05,007', 3_605_007],
    ['83.5', 83_500],
    ['2:03', 123_000],
    [' 00:00.1 ', 100],
  ])('đọc %s', (input, ms) => {
    expect(parseCueTime(input)).toBe(ms);
  });
  it.each(['', 'abc', '1:2:3:4', '-1', '00:61', '1:60:00', '00:00.0001'])('từ chối %j', (input) => {
    expect(parseCueTime(input)).toBeNull();
  });
});
