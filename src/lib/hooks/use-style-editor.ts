'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ApiError, apiPut, holdLoginRedirect } from '@/lib/api-client';
import { videoKeys, type VideoJobDetailDto } from '@/lib/hooks/use-video';
import { useT } from '@/lib/i18n/client';
import { StyleStore } from '@/lib/video/style-store';
import type { VideoStyle } from '@/lib/video/style';

/**
 * Kiểu phụ đề trong trình biên tập (spec 006, FR-031): sửa ngay, tự lưu. Chưa lưu xong thì đóng hoặc tải lại thẻ phải hỏi, hết phiên
 * không tự chuyển trang; rời trang thì gửi nốt và báo nếu không lưu được.
 */
export function useStyleEditor(job: Pick<VideoJobDetailDto, 'id' | 'projectId' | 'style'>) {
  const t = useT();
  const qc = useQueryClient();
  const [store] = useState(
    () =>
      new StyleStore({
        style: job.style,
        save: async (style: VideoStyle) => {
          const saved = await apiPut<{ style: VideoStyle }>(`/api/video/jobs/${job.id}/style`, style).catch((e: unknown) => {
            // lỗi mạng chỉ có thông báo thô của trình duyệt: không hiện
            throw e instanceof ApiError ? e : new Error('');
          });
          // lượt đọc đang dở trả kiểu cũ: bỏ nó, ghi kiểu mới vào bản đệm (mở lại trang không thấy bản cũ) rồi đọc lại
          await qc.cancelQueries({ queryKey: videoKeys.job(job.id) });
          qc.setQueryData<VideoJobDetailDto>(videoKeys.job(job.id), (old) => (old ? { ...old, style: saved.style } : old));
          void qc.invalidateQueries({ queryKey: videoKeys.job(job.id) });
          void qc.invalidateQueries({ queryKey: videoKeys.tab(job.projectId) });
        },
      }),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    store.adopt(job.style);
  }, [store, job.style]);

  const lost = t.video.editor.style.saveError;
  const lostText = useRef(lost);
  useEffect(() => {
    lostText.current = lost;
  }, [lost]);

  useEffect(() => {
    let left = false;
    const warn = (e: BeforeUnloadEvent) => {
      if (store.getSnapshot().status !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    const release = holdLoginRedirect(() => {
      // đã sang trang khác mà hết phiên: để ứng dụng chuyển tới đăng nhập
      const { status, errorCode } = store.getSnapshot();
      if (left && errorCode === 'UNAUTHENTICATED') return false;
      return status !== 'saved';
    });
    return () => {
      left = true;
      // giữ hai lớp bảo vệ tới khi lượt gửi cuối có kết quả
      const settle = () => {
        const { status, error } = store.getSnapshot();
        if (status === 'pending' || status === 'saving') return;
        off();
        release();
        window.removeEventListener('beforeunload', warn);
        if (status === 'error') toast.error(lostText.current, { description: error || undefined });
      };
      const off = store.subscribe(settle);
      store.dispose();
      settle();
    };
  }, [store]);

  return { store, ...snapshot };
}
