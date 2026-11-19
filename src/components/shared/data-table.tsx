'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  className?: string;
};

type Props<T> = {
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  /** Bật chọn nhiều khi truyền `selected` + `onSelectedChange` */
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  onRowClick?: (row: T) => void;
  selectLabel?: string;
  selectAllLabel?: string;
};

/** Bảng dữ liệu dùng chung, có chọn nhiều (xóa hàng loạt) và cuộn ngang trên màn hình nhỏ. */
export function DataTable<T>({
  rows,
  columns,
  rowId,
  selected,
  onSelectedChange,
  onRowClick,
  selectLabel = 'select',
  selectAllLabel = 'select all',
}: Props<T>) {
  const selectable = !!selected && !!onSelectedChange;
  const allIds = rows.map(rowId);
  const allSelected = selectable && allIds.length > 0 && allIds.every((id) => selected!.has(id));
  const someSelected = selectable && allIds.some((id) => selected!.has(id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange!(next);
  };

  return (
    <div className="w-full overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead className="w-10">
                <Checkbox
                  aria-label={selectAllLabel}
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(v) => onSelectedChange!(v ? new Set(allIds) : new Set())}
                />
              </TableHead>
            ) : null}
            {columns.map((c) => (
              <TableHead key={c.key} className={c.className}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const id = rowId(row);
            return (
              <TableRow
                key={id}
                data-state={selectable && selected!.has(id) ? 'selected' : undefined}
                className={cn(onRowClick && 'cursor-pointer')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {selectable ? (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox aria-label={selectLabel} checked={selected!.has(id)} onCheckedChange={(v) => toggle(id, !!v)} />
                  </TableCell>
                ) : null}
                {columns.map((c) => (
                  <TableCell key={c.key} className={c.className}>
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
