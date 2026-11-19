export type Page = { page: number; pageSize: number; offset: number };

export function toPage(page: number, pageSize: number): Page {
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export function paged<T>(items: T[], total: number, p: Page): Paged<T> {
  return { items, total, page: p.page, pageSize: p.pageSize };
}
