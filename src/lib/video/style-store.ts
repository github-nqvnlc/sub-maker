import { normalizeStyle, type VideoStyle } from './style';

/**
 * Kiểu phụ đề đang chỉnh trong trình biên tập (spec 006, T099; FR-031): đổi là hiện ngay, tự lưu sau khi ngừng chỉnh. Mỗi lúc chỉ một
 * lượt gửi nên bản cũ không đến sau bản mới; lưu lỗi thì giữ thay đổi, gửi lại khi chỉnh tiếp, bấm thử lại hoặc rời trang.
 */

export type StyleSaveStatus = 'saved' | 'pending' | 'saving' | 'error';

export type StyleSnapshot = {
  style: VideoStyle;
  status: StyleSaveStatus;
  /** thông báo của lượt lưu lỗi gần nhất; giữ tới khi lưu thành công để dải báo không chớp trong lúc thử lại */
  error: string | null;
  /** mã của lỗi đó nếu có (để biết phiên đăng nhập đã hết) */
  errorCode: string | null;
  /** tăng sau mỗi lượt lưu thành công: phần ước tính xuất video đọc lại theo số này */
  savedVersion: number;
};

type Options = { style: VideoStyle; save: (style: VideoStyle) => Promise<unknown>; delayMs?: number };

export class StyleStore {
  private snapshot: StyleSnapshot;
  private savedJson: string;
  private touched = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<boolean> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly save: Options['save'];
  private readonly delayMs: number;

  constructor({ style, save, delayMs = 600 }: Options) {
    this.snapshot = { style, status: 'saved', error: null, errorCode: null, savedVersion: 0 };
    this.savedJson = JSON.stringify(style);
    this.save = save;
    this.delayMs = delayMs;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StyleSnapshot => this.snapshot;

  private emit(patch: Partial<StyleSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private get dirty(): boolean {
    return JSON.stringify(this.snapshot.style) !== this.savedJson;
  }

  set(next: VideoStyle): void {
    const { style } = normalizeStyle(next);
    if (JSON.stringify(style) === JSON.stringify(this.snapshot.style)) return;
    this.touched = true;
    this.clearTimer();
    // đang gửi thì vòng lưu tự gửi tiếp bản mới
    if (this.running) return this.emit({ style });
    this.emit({ style, status: 'pending' });
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Bản đọc từ máy chủ (mới hơn bản lúc mở trang): chỉ nhận khi người dùng chưa chỉnh gì trong lần mở này. */
  adopt(style: VideoStyle): void {
    if (this.touched || JSON.stringify(style) === this.savedJson) return;
    this.savedJson = JSON.stringify(style);
    this.emit({ style });
  }

  /** Gửi ngay phần chưa lưu và đợi; `false` khi không lưu được. */
  flush(): Promise<boolean> {
    this.clearTimer();
    if (this.running) return this.running;
    if (!this.dirty) {
      if (this.snapshot.status !== 'saved') this.emit({ status: 'saved', error: null, errorCode: null });
      return Promise.resolve(true);
    }
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  retry(): void {
    void this.flush();
  }

  /** Rời trang: gửi nốt thay đổi chưa lưu, kể cả sau một lượt lỗi. */
  dispose(): void {
    if (this.dirty) void this.flush();
  }

  private async drain(): Promise<boolean> {
    while (this.dirty) {
      const sending = this.snapshot.style;
      this.emit({ status: 'saving' });
      try {
        await this.save(sending);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        this.emit({ status: 'error', error: e instanceof Error ? e.message : String(e), errorCode: typeof code === 'string' ? code : null });
        return false;
      }
      this.savedJson = JSON.stringify(sending);
      this.emit({ savedVersion: this.snapshot.savedVersion + 1 });
    }
    this.emit({ status: 'saved', error: null, errorCode: null });
    return true;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
