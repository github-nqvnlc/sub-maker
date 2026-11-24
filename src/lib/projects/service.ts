import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db';
import { projects, subtitleFiles, voiceJobs, voices } from '../db/schema';
import { toPage } from '../api/pagination';
import type { ProviderType } from '../schemas/common';
import { getOwnedProject } from './access';
import { fileDto, jobDto, projectDto, voiceDto } from './dto';

/** Từ khóa tìm kiếm: thoát ký tự đặc biệt của LIKE, bỏ dấu và chữ thường (cùng hàm với cột search_text). */
function likePattern(q: string): SQL {
  const escaped = q.trim().replace(/[\\%_]/g, '\\$&');
  return sql`'%' || immutable_unaccent(lower(${escaped})) || '%'`;
}

export type ProjectSort = 'name' | 'createdAt' | 'updatedAt' | 'voiceCount';
export type JobStateFilter = 'running' | 'failed' | 'none';

export type ListProjectsOpts = {
  q?: string;
  sort?: ProjectSort;
  order?: 'asc' | 'desc';
  provider?: ProviderType;
  jobState?: JobStateFilter;
  page: number;
  pageSize: number;
};

// Dùng tham chiếu CÓ TIỀN TỐ BẢNG ("projects"."id"): Drizzle bỏ tiền tố cột trong danh sách select của truy vấn một bảng,
// khiến truy vấn con tương quan so khớp nhầm với voice_jobs.id.
const PROJECT_ID = sql.raw('"projects"."id"');
const runningJobsSql = sql<number>`(select count(*)::int from voice_jobs j where j.project_id = ${PROJECT_ID} and j.status in ('queued','running'))`;
const failedJobsSql = sql<number>`(select count(*)::int from voice_jobs j where j.project_id = ${PROJECT_ID} and j.status = 'failed')`;
const anyJobSql = sql`exists (select 1 from voice_jobs j where j.project_id = ${PROJECT_ID})`;

/** Danh sách Project của một User: tìm kiếm không dấu, sắp xếp, lọc, phân trang (FR-005..008). */
export async function listProjects(ownerId: string, opts: ListProjectsOpts) {
  const db = getDb();
  const conds: SQL[] = [eq(projects.ownerId, ownerId)];
  if (opts.q?.trim()) conds.push(sql`${sql.raw('projects.search_text')} like ${likePattern(opts.q)} escape '\\'`);
  if (opts.provider) {
    if (opts.provider === 'shopaikey_minimax' || opts.provider === 'shopaikey_openai') {
      conds.push(inArray(projects.providerType, ['shopaikey_minimax', 'shopaikey_openai']));
    } else {
      conds.push(eq(projects.providerType, opts.provider));
    }
  }
  if (opts.jobState === 'running') conds.push(sql`${runningJobsSql} > 0`);
  else if (opts.jobState === 'failed') conds.push(sql`${failedJobsSql} > 0`);
  else if (opts.jobState === 'none') conds.push(sql`not ${anyJobSql}`);
  const where = and(...conds);

  const dir = opts.order === 'asc' ? asc : desc;
  const sortCol =
    opts.sort === 'name'
      ? sql`lower(${projects.name})`
      : opts.sort === 'createdAt'
        ? projects.createdAt
        : opts.sort === 'voiceCount'
          ? projects.voiceCount
          : projects.updatedAt;
  const p = toPage(opts.page, opts.pageSize);

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(projects).where(where);
  const rows = await db
    .select({ p: projects, runningJobs: runningJobsSql, failedJobs: failedJobsSql })
    .from(projects)
    .where(where)
    // sắp xếp phụ theo id để thứ tự ổn định khi trùng giá trị
    .orderBy(dir(sortCol), asc(projects.id))
    .limit(p.pageSize)
    .offset(p.offset);

  return {
    items: rows.map((r) => ({ ...projectDto(r.p), voiceCount: r.p.voiceCount, runningJobs: r.runningJobs, failedJobs: r.failedJobs })),
    total: Number(total),
    page: p.page,
    pageSize: p.pageSize,
  };
}

export async function createProject(ownerId: string, input: { name: string; description?: string | null; providerType?: ProviderType }) {
  const [row] = await getDb()
    .insert(projects)
    .values({
      ownerId,
      name: input.name.trim(),
      description: input.description?.trim() ? input.description.trim() : null,
      providerType: input.providerType ?? 'fpt_marketplace',
    })
    .returning();
  return projectDto(row!);
}

export async function updateProject(
  ownerId: string,
  id: string,
  patch: { name?: string; description?: string | null; providerType?: ProviderType },
) {
  await getOwnedProject(ownerId, id);
  // Dùng now() của CSDL (đồng hồ ứng dụng và CSDL có thể lệch nhau, làm sai thứ tự "mới cập nhật")
  const set: Partial<typeof projects.$inferInsert> = { updatedAt: sql`now()` as unknown as Date };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.description !== undefined) set.description = patch.description?.trim() ? patch.description.trim() : null;
  if (patch.providerType !== undefined) set.providerType = patch.providerType;
  const [row] = await getDb()
    .update(projects)
    .set(set)
    .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
    .returning();
  return projectDto(row!);
}

/** Chi tiết Project gồm file, tiến trình và voice (FR-002). */
export async function getProjectDetail(ownerId: string, id: string) {
  const project = await getOwnedProject(ownerId, id);
  const db = getDb();
  const [files, jobs, vs] = await Promise.all([
    db.select().from(subtitleFiles).where(eq(subtitleFiles.projectId, id)).orderBy(desc(subtitleFiles.createdAt)),
    db.select().from(voiceJobs).where(eq(voiceJobs.projectId, id)).orderBy(desc(voiceJobs.createdAt)),
    db.select().from(voices).where(eq(voices.projectId, id)).orderBy(desc(voices.createdAt)),
  ]);
  const voiceByJob = new Map(vs.map((v) => [v.jobId, v.id]));
  return {
    ...projectDto(project),
    files: files.map(fileDto),
    jobs: jobs.map((j) => jobDto(j, voiceByJob.get(j.id) ?? null)),
    voices: vs.map(voiceDto),
  };
}

/** Các id thuộc về chủ sở hữu trong danh sách (dùng cho xóa hàng loạt). */
export async function ownedProjectIds(ownerId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), inArray(projects.id, ids)));
  return new Set(rows.map((r) => r.id));
}
