import { AlertTriangle, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { vi } from '@/lib/i18n/vi';

/** Trạng thái rỗng: có thể kèm hành động (ví dụ "Tạo Project đầu tiên"). */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center">
      <Icon className="size-10 text-muted-foreground" />
      <p className="text-base font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

/** Trạng thái lỗi: nêu nguyên nhân và cho thử lại. */
export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center">
      <AlertTriangle className="size-8 text-destructive" />
      <p className="text-sm">{message ?? vi.common.genericError}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {vi.common.retry}
        </Button>
      ) : null}
    </div>
  );
}

/** Khung chờ cho danh sách/bảng. */
export function LoadingList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={vi.common.loading}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
