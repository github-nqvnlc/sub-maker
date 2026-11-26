import { ApiError } from '../api-client';
import { applyOps, MAX_CUE_OPS, type CueBatch, type CueOp, type CueViolation } from './cue-ops';
import type { Cue } from './types';

/**
 * Trạng thái của trình biên tập phụ đề (spec 006, FR-023, FR-024): áp thao tác ngay trên máy, tự lưu theo lô sau 800 ms yên lặng,
 * hoàn tác và làm lại trong phiên. Bản trên máy chủ đã đổi (hoặc không nhận lô) thì dừng lưu và đòi tải lại, không đè âm thầm.
 * Không phụ thuộc React.
 */
export const SAVE_DELAY_MS = 800;
/** Lưu lỗi vì mạng hoặc máy chủ thì thử lại sau khoảng này. */
export const RETRY_MS = 5000;
/** Các lần sửa cùng một ô cách nhau dưới mức này gộp thành một bước hoàn tác. */
const MERGE_MS = 1500;
const MAX_HISTORY = 500;
/** Mã mà gửi lại cùng lô cũng không được: phải tải lại. */
const NEEDS_RELOAD = new Set(['CUE_CONFLICT', 'CUE_INVALID', 'VIDEO_NOT_EDITABLE', 'NOT_FOUND', 'VALIDATION']);

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export type EditorSnapshot = {
  cues: readonly Cue[];
  revision: number;
  status: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  /** lỗi lưu gần nhất */
  error: { code: string; message: string | null } | null;
};

export type CueEditorOptions = {
  cues: readonly Cue[];
  revision: number;
  durationMs: number;
  save: (batch: CueBatch) => Promise<{ revision: number }>;
  /** đã rời trang mà chưa lưu được: `retrying` cho biết còn thử lại hay đã bỏ cuộc */
  onLost?: (error: EditorSnapshot['error'], retrying: boolean) => void;
};

type Step = { ops: CueOp[]; merge?: string; at: number };

/** Hai thao tác sửa chữ liên tiếp trên cùng ô chỉ cần gửi giá trị cuối. */
function squash(queue: CueOp[], op: CueOp): void {
  const last = queue.at(-1);
  if (op.type === 'update' && last?.type === 'update' && last.id === op.id) {
    const keys = Object.keys(op.patch);
    if (keys.length === Object.keys(last.patch).length && keys.every((k) => (k === 'sourceText' || k === 'targetText') && k in last.patch)) {
      queue[queue.length - 1] = op;
      return;
    }
  }
  queue.push(op);
}

export class CueEditorStore {
  private cues: readonly Cue[];
  private revision: number;
  private readonly durationMs: number;
  private readonly save: CueEditorOptions['save'];
  private readonly onLost: CueEditorOptions['onLost'];
  private queue: CueOp[] = [];
  private undone: Step[] = [];
  private done: Step[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private failure: EditorSnapshot['error'] = null;
  private blocked = false;
  private disposed = false;
  private warned = false;
  private listeners = new Set<() => void>();
  private snapshot: EditorSnapshot;

  constructor(options: CueEditorOptions) {
    this.cues = options.cues;
    this.revision = options.revision;
    this.durationMs = options.durationMs;
    this.save = options.save;
    this.onLost = options.onLost;
    this.snapshot = this.build();
  }

  getSnapshot = (): EditorSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Áp một lô thao tác; trả cue vi phạm nếu lô bị từ chối. `merge`: khóa gộp bước hoàn tác (ví dụ ô đang gõ). */
  apply(ops: readonly CueOp[], opts: { merge?: string } = {}): CueViolation | null {
    if (this.blocked) return null;
    const result = applyOps(this.cues, ops, this.durationMs);
    if (!result.ok) return result.violation;
    if (result.inverse.length === 0) return null;
    const now = Date.now();
    const last = this.done.at(-1);
    // gộp: giữ thao tác ngược của lần đầu, nó đưa ô về giá trị trước cả chuỗi sửa
    if (opts.merge && last?.merge === opts.merge && now - last.at < MERGE_MS) last.at = now;
    else this.done.push({ ops: result.inverse, merge: opts.merge, at: now });
    if (this.done.length > MAX_HISTORY) this.done.shift();
    this.undone = [];
    this.commit(result.cues, ops);
    return null;
  }

  undo(): void {
    this.step(this.done, this.undone);
  }

  redo(): void {
    this.step(this.undone, this.done);
  }

  private step(from: Step[], to: Step[]): void {
    if (this.blocked) return;
    const entry = from.pop();
    if (!entry) return;
    const result = applyOps(this.cues, entry.ops, this.durationMs);
    if (!result.ok) return this.publish();
    to.push({ ops: result.inverse, at: 0 });
    this.commit(result.cues, entry.ops);
  }

  private commit(cues: readonly Cue[], ops: readonly CueOp[]): void {
    this.cues = cues;
    for (const op of ops) squash(this.queue, op);
    this.schedule(SAVE_DELAY_MS);
    this.publish();
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  /** Gửi ngay phần chưa lưu (nếu đang gửi thì đợi lô đó). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sending) return this.sending;
    if (this.blocked || this.queue.length === 0) return;
    const ops = this.queue.splice(0, MAX_CUE_OPS);
    this.sending = this.send(ops);
    this.publish();
    return this.sending;
  }

  private async send(ops: CueOp[]): Promise<void> {
    try {
      const { revision } = await this.save({ baseRevision: this.revision, ops });
      this.revision = revision;
      this.sending = null;
      this.failure = null;
      if (this.queue.length > 0) {
        if (this.disposed) return this.flush();
        this.schedule(SAVE_DELAY_MS);
      }
    } catch (e) {
      this.sending = null;
      this.queue.unshift(...ops);
      this.failure = e instanceof ApiError ? { code: e.code, message: e.message } : { code: 'NETWORK', message: null };
      if (e instanceof ApiError && NEEDS_RELOAD.has(e.code)) {
        this.blocked = true;
        if (this.disposed) this.onLost?.(this.failure, false);
      } else {
        this.schedule(RETRY_MS);
        if (this.disposed && !this.warned) {
          this.warned = true;
          this.onLost?.(this.failure, true);
        }
      }
    }
    this.publish();
  }

  retry(): void {
    void this.flush();
  }

  /** Thay bằng bản của máy chủ, bỏ thay đổi chưa lưu và lịch sử. */
  reset(cues: readonly Cue[], revision: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cues = cues;
    this.revision = revision;
    this.queue = [];
    this.done = [];
    this.undone = [];
    this.failure = null;
    this.blocked = false;
    this.publish();
  }

  /** Nhận bản mới hơn của máy chủ (tab khác đã lưu, dịch lại) khi không còn gì chưa lưu. */
  adopt(cues: readonly Cue[], revision: number): boolean {
    if (revision <= this.revision || this.sending || this.queue.length > 0) return false;
    this.reset(cues, revision);
    return true;
  }

  /** Rời trang: gửi ngay phần chưa lưu; lỗi tạm thì vẫn thử lại tới khi lưu được. Không lưu được nữa thì báo `onLost`. */
  dispose(): void {
    this.disposed = true;
    if (this.blocked) this.onLost?.(this.failure, false);
    else void this.flush();
  }

  /** Dùng lại sau `dispose` (React gắn lại thành phần). */
  revive(): void {
    this.disposed = false;
    this.warned = false;
  }

  private build(): EditorSnapshot {
    const status: SaveStatus = this.blocked ? 'conflict' : this.sending ? 'saving' : this.failure ? 'error' : this.queue.length > 0 ? 'dirty' : 'saved';
    return { cues: this.cues, revision: this.revision, status, canUndo: !this.blocked && this.done.length > 0, canRedo: !this.blocked && this.undone.length > 0, error: this.failure };
  }

  private publish(): void {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }
}
