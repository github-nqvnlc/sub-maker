'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { apiPost, holdLoginRedirect } from '@/lib/api-client';
import type { CueListDto } from '@/lib/video/cues';
import { CueEditorStore } from '@/lib/video/cue-editor-store';
import { useT } from '@/lib/i18n/client';

/**
 * Trình biên tập phụ đề của một việc (spec 006, FR-023, FR-024): sửa ngay, tự lưu, hoàn tác, báo xung đột. `loaded` là bản mới nhất đọc
 * từ máy chủ; bản mới hơn được nhận khi không còn thay đổi chưa lưu.
 */
export function useCueEditor(jobId: string, loaded: CueListDto, durationMs: number) {
  const t = useT();
  const [store] = useState(
    () =>
      new CueEditorStore({
        cues: loaded.cues,
        revision: loaded.revision,
        durationMs,
        save: (batch) => apiPost<{ revision: number }>(`/api/video/jobs/${jobId}/cues/ops`, batch),
        onLost: (error, retrying) => toast.error(error?.message ?? t.video.editor.save.error, { description: retrying ? t.video.editor.save.error : t.video.editor.save.lost }),
      }),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    store.revive();
    let left = false;
    // còn thay đổi chưa lưu thì đóng hoặc tải lại thẻ phải hỏi, và hết phiên không tự chuyển trang
    const warn = (e: BeforeUnloadEvent) => {
      if (store.getSnapshot().status !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    const release = holdLoginRedirect(() => {
      const { status, error } = store.getSnapshot();
      // đã sang trang khác mà hết phiên: để ứng dụng chuyển tới đăng nhập (trình duyệt vẫn hỏi trước khi rời)
      if (left && error?.code === 'UNAUTHENTICATED') return false;
      return status !== 'saved' && status !== 'conflict';
    });
    return () => {
      left = true;
      store.dispose();
      // giữ hai lớp bảo vệ tới khi lưu xong hoặc không còn lưu được
      const settle = () => {
        const { status } = store.getSnapshot();
        if (status !== 'saved' && status !== 'conflict') return;
        off();
        release();
        window.removeEventListener('beforeunload', warn);
      };
      const off = store.subscribe(settle);
      settle();
    };
  }, [store]);

  useEffect(() => {
    store.adopt(loaded.cues, loaded.revision);
  }, [store, loaded]);

  return { store, ...snapshot };
}
