import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import { users } from '../db/schema';
import { notFound, validation } from '../api/errors';
import { getSettings } from '../settings';
import { toAdminUser, type AdminUserDto } from '../users/admin-service';
import { videoSystemBytes } from '../video/quota';

/**
 * Thống kê (US8, FR-038..040). Nguyên tắc:
 *  - chỉ cộng bản ghi `usage_records.ok = true`; lần dùng lại từ cache không có bản ghi nên không bị tính;
 *  - `tokens` / `costEstimateUsd` là NULL nếu không bản ghi nào có giá trị (không bịa số — Nguyên tắc IV);
 *  - bản ghi của User đã xóa (user_id NULL) vẫn nằm trong tổng toàn hệ thống nhưng không thuộc User nào;
 *  - ngày được chia theo múi giờ Việt Nam để khớp cảm nhận của người dùng.
 */
export const STATS_TZ = 'Asia/Ho_Chi_Minh';
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ (định dạng YYYY-MM-DD)');
export const rangeQuerySchema = z.object({ from: dateStr.optional(), to: dateStr.optional() });

export type Range = { from: string; to: string };

function isoDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: STATS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Khoảng ngày [from, to] (gồm cả hai đầu). Mặc định 30 ngày gần nhất. */
export function resolveRange(q: { from?: string; to?: string }): Range {
  const to = q.to ?? isoDay(new Date());
  const from = q.from ?? isoDay(new Date(new Date(`${to}T00:00:00Z`).getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000));
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw validation({ from: 'Ngày không hợp lệ' });
  if (a > b) throw validation({ from: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc' });
  if ((b - a) / 86_400_000 > MAX_RANGE_DAYS) throw validation({ from: `Khoảng thời gian tối đa ${MAX_RANGE_DAYS} ngày` });
  return { from, to };
}

/** Điều kiện thời gian cho `usage_records.ts` theo khoảng ngày (gồm cả ngày `to`). */
const inRange = (r: Range) =>
  sql`ts >= (${r.from}::date)::timestamp at time zone ${STATS_TZ} and ts < ((${r.to}::date + 1))::timestamp at time zone ${STATS_TZ}`;

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

type Rows<T> = { rows: T[] };

export type DashboardDto = {
  range: Range;
  projects: number;
  voices: number;
  totalDurationMs: number;
  jobsByStatus: Record<string, number>;
  usage: {
    chars: number;
    tokens: number | null;
    costEstimateUsd: number | null;
    byDay: { date: string; chars: number; costEstimateUsd: number | null }[];
    byProvider: { providerType: string; configScope: 'global' | 'user'; chars: number }[];
  };
  storageUsedBytes: number;
  storageQuotaBytes: number;
};

export async function getDashboard(userId: string, range: Range): Promise<DashboardDto> {
  const db = getDb();
  const [u] = await db.select({ storage: users.storageUsedBytes }).from(users).where(eq(users.id, userId));
  if (!u) throw notFound();

  const [counts, jobs, totals, byDay, byProvider, settings] = await Promise.all([
    db.execute(sql`
      select
        (select count(*)::int from projects where owner_id = ${userId}) as projects,
        (select count(*)::int from voices where owner_id = ${userId}) as voices,
        (select coalesce(sum(duration_ms), 0)::bigint from voices where owner_id = ${userId}) as duration`) as unknown as Promise<Rows<{ projects: number; voices: number; duration: string }>>,
    db.execute(sql`select status, count(*)::int as n from voice_jobs where owner_id = ${userId} group by status`) as unknown as Promise<Rows<{ status: string; n: number }>>,
    db.execute(sql`
      select coalesce(sum(units_chars), 0)::bigint as chars, sum(units_tokens)::bigint as tokens, sum(cost_estimate_usd) as cost
      from usage_records where user_id = ${userId} and ok and ${inRange(range)}`) as unknown as Promise<Rows<{ chars: string; tokens: string | null; cost: string | null }>>,
    db.execute(sql`
      select to_char((ts at time zone ${STATS_TZ})::date, 'YYYY-MM-DD') as date, sum(units_chars)::bigint as chars, sum(cost_estimate_usd) as cost
      from usage_records where user_id = ${userId} and ok and ${inRange(range)}
      group by 1 order by 1`) as unknown as Promise<Rows<{ date: string; chars: string; cost: string | null }>>,
    db.execute(sql`
      select provider_type as "providerType", config_scope as "configScope", sum(units_chars)::bigint as chars
      from usage_records where user_id = ${userId} and ok and ${inRange(range)}
      group by 1, 2 order by 3 desc`) as unknown as Promise<Rows<{ providerType: string; configScope: 'global' | 'user'; chars: string }>>,
    getSettings(),
  ]);

  const c = counts.rows[0];
  const t = totals.rows[0];
  return {
    range,
    projects: num(c?.projects),
    voices: num(c?.voices),
    totalDurationMs: num(c?.duration),
    jobsByStatus: Object.fromEntries(jobs.rows.map((r) => [r.status, num(r.n)])),
    usage: {
      chars: num(t?.chars),
      tokens: numOrNull(t?.tokens),
      costEstimateUsd: numOrNull(t?.cost),
      byDay: byDay.rows.map((r) => ({ date: r.date, chars: num(r.chars), costEstimateUsd: numOrNull(r.cost) })),
      byProvider: byProvider.rows.map((r) => ({ providerType: r.providerType, configScope: r.configScope, chars: num(r.chars) })),
    },
    storageUsedBytes: u.storage,
    storageQuotaBytes: settings.userQuotaBytes,
  };
}

export const STATS_SORTS = ['projects', 'voices', 'chars', 'cost', 'storage', 'video', 'lastActive'] as const;
export type StatsSort = (typeof STATS_SORTS)[number];

export type AdminStatsDto = {
  range: Range;
  totals: {
    users: number;
    projects: number;
    voices: number;
    chars: number;
    tokens: number | null;
    costEstimateUsd: number | null;
    storageUsedBytes: number;
    /** dung lượng video toàn hệ thống theo đúng cách so với trần (FR-053): đã dùng, giữ chỗ và bản xem trước */
    video: { usedBytes: number; capBytes: number };
    charsByScope: { global: number; user: number };
  };
  users: {
    user: AdminUserDto;
    projects: number;
    voices: number;
    chars: number;
    charsByScope: { global: number; user: number };
    tokens: number | null;
    costEstimateUsd: number | null;
    storageUsedBytes: number;
    videoUsedBytes: number;
  }[];
};

/** Thống kê toàn hệ thống + từng User. Chỉ số liệu tổng hợp — không có nội dung Project (Nguyên tắc I). */
export async function getAdminStats(range: Range, sort: StatsSort, order: 'asc' | 'desc'): Promise<AdminStatsDto> {
  const db = getDb();
  const [perUser, totals, sums, videoBytes, settings] = await Promise.all([
    db.execute(sql`
      select u.id,
        (select count(*)::int from projects p where p.owner_id = u.id) as projects,
        (select count(*)::int from voices v where v.owner_id = u.id) as voices,
        coalesce(r.chars, 0)::bigint as chars,
        coalesce(r.chars_global, 0)::bigint as chars_global,
        coalesce(r.chars_user, 0)::bigint as chars_user,
        r.tokens, r.cost
      from users u
      left join (
        select user_id, sum(units_chars) as chars,
          sum(units_chars) filter (where config_scope = 'global') as chars_global,
          sum(units_chars) filter (where config_scope = 'user') as chars_user,
          sum(units_tokens) as tokens, sum(cost_estimate_usd) as cost
        from usage_records where ok and user_id is not null and ${inRange(range)}
        group by user_id
      ) r on r.user_id = u.id`) as unknown as Promise<
      Rows<{ id: string; projects: number; voices: number; chars: string; chars_global: string; chars_user: string; tokens: string | null; cost: string | null }>
    >,
    // Tổng toàn hệ thống gồm cả bản ghi ẩn danh của User đã xóa
    db.execute(sql`
      select coalesce(sum(units_chars), 0)::bigint as chars,
        coalesce(sum(units_chars) filter (where config_scope = 'global'), 0)::bigint as chars_global,
        coalesce(sum(units_chars) filter (where config_scope = 'user'), 0)::bigint as chars_user,
        sum(units_tokens)::bigint as tokens, sum(cost_estimate_usd) as cost
      from usage_records where ok and ${inRange(range)}`) as unknown as Promise<
      Rows<{ chars: string; chars_global: string; chars_user: string; tokens: string | null; cost: string | null }>
    >,
    db.execute(sql`
      select (select count(*)::int from users) as users,
        (select count(*)::int from projects) as projects,
        (select count(*)::int from voices) as voices,
        (select coalesce(sum(storage_used_bytes), 0)::bigint from users) as storage`) as unknown as Promise<
      Rows<{ users: number; projects: number; voices: number; storage: string }>
    >,
    videoSystemBytes(),
    getSettings(),
  ]);

  const allUsers = await db.select().from(users);
  const byId = new Map(allUsers.map((u) => [u.id, u]));
  const rows = perUser.rows
    .map((r) => {
      const u = byId.get(r.id);
      if (!u) return null;
      return {
        user: toAdminUser(u),
        projects: num(r.projects),
        voices: num(r.voices),
        chars: num(r.chars),
        charsByScope: { global: num(r.chars_global), user: num(r.chars_user) },
        tokens: numOrNull(r.tokens),
        costEstimateUsd: numOrNull(r.cost),
        storageUsedBytes: u.storageUsedBytes,
        videoUsedBytes: u.videoUsedBytes,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const key = (r: (typeof rows)[number]): number => {
    switch (sort) {
      case 'projects':
        return r.projects;
      case 'voices':
        return r.voices;
      case 'chars':
        return r.chars;
      case 'cost':
        return r.costEstimateUsd ?? -1;
      case 'storage':
        return r.storageUsedBytes;
      case 'video':
        return r.videoUsedBytes;
      case 'lastActive':
        return r.user.lastActiveAt ? Date.parse(r.user.lastActiveAt) : 0;
    }
  };
  const dir = order === 'asc' ? 1 : -1;
  rows.sort((a, b) => (key(a) - key(b)) * dir || a.user.email.localeCompare(b.user.email));

  const t = totals.rows[0];
  const s = sums.rows[0];
  return {
    range,
    totals: {
      users: num(s?.users),
      projects: num(s?.projects),
      voices: num(s?.voices),
      chars: num(t?.chars),
      tokens: numOrNull(t?.tokens),
      costEstimateUsd: numOrNull(t?.cost),
      storageUsedBytes: num(s?.storage),
      video: { usedBytes: videoBytes, capBytes: settings.videoSystemCapBytes },
      charsByScope: { global: num(t?.chars_global), user: num(t?.chars_user) },
    },
    users: rows,
  };
}
