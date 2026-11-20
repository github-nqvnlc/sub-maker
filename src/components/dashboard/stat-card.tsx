import { Card, CardContent } from '@/components/ui/card';

/** Thẻ số liệu. `muted` dùng khi không có số (ví dụ chi phí chưa cấu hình giá) để không hiển thị số bịa. */
export function StatCard({ label, value, hint, muted, testId }: { label: string; value: React.ReactNode; hint?: string; muted?: boolean; testId?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p data-testid={testId} className={muted ? 'text-base text-muted-foreground' : 'text-2xl font-semibold tabular-nums'}>
          {value}
        </p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

