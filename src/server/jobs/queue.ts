import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";

export type JobRow = typeof jobs.$inferSelect;

export type EnqueueOptions = {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** When set, a second enqueue with the same key is ignored while the first is queued/running. */
  dedupeKey?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  createdBy?: string | null;
  /** Demo projects (settings.demo) never run project-scoped jobs unless explicitly allowed. */
  allowDemo?: boolean;
};

export async function enqueueJob(
  type: string,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<JobRow | null> {
  // Demo projects hold generated sample data: never sync, crawl, track or call providers for them.
  const scopedProject = opts.projectId ?? (typeof payload.projectId === "string" ? payload.projectId : null);
  if (scopedProject && !opts.allowDemo) {
    const { isDemoProjectId } = await import("@/server/ai/demo/guard");
    if (await isDemoProjectId(scopedProject)) {
      console.info(`[jobs] skipped "${type}" for demo project ${scopedProject}`);
      return null;
    }
  }
  const values = {
    type,
    payload,
    runAt: opts.runAt ?? new Date(),
    priority: opts.priority ?? 100,
    maxAttempts: opts.maxAttempts ?? 3,
    dedupeKey: opts.dedupeKey ?? null,
    projectId: opts.projectId ?? null,
    workspaceId: opts.workspaceId ?? null,
    createdBy: opts.createdBy ?? null,
  };
  if (opts.dedupeKey) {
    // Free up the dedupe key of finished jobs so the job can be scheduled again.
    await db
      .update(jobs)
      .set({ dedupeKey: null })
      .where(and(eq(jobs.dedupeKey, opts.dedupeKey), inArray(jobs.status, ["succeeded", "failed", "cancelled"])));
    const [row] = await db.insert(jobs).values(values).onConflictDoNothing({ target: jobs.dedupeKey }).returning();
    return row ?? null;
  }
  const [row] = await db.insert(jobs).values(values).returning();
  return row!;
}

export async function getJob(id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

export async function cancelJob(id: string) {
  await db
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date(), dedupeKey: null })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "running"])));
}

export async function setJobProgress(id: string, progress: Record<string, unknown>) {
  await db.update(jobs).set({ progress }).where(eq(jobs.id, id));
}

/**
 * Atomically claims up to `limit` due jobs for this worker. `room` maps each job type that may start
 * to how many more of it may start now; one type never takes more than its room.
 */
export async function claimJobs(workerId: string, room: Record<string, number>, limit: number): Promise<JobRow[]> {
  const entries = Object.entries(room).filter(([, n]) => n > 0);
  if (!entries.length || limit <= 0) return [];
  const caps = sql.join(
    entries.map(([type, n]) => sql`(${type}, ${n}::int)`),
    sql`, `,
  );
  // MATERIALIZED CTE guarantees the LIMIT is applied once (a plain IN-subquery may be re-evaluated).
  const rows = await db.execute(sql`
    WITH caps(type, room) AS (VALUES ${caps}),
    ranked AS (
      SELECT j.id, row_number() OVER (PARTITION BY j.type ORDER BY j.priority ASC, j.run_at ASC) AS rn, c.room
      FROM jobs j JOIN caps c ON c.type = j.type
      WHERE j.status = 'queued' AND j.run_at <= now()
    ),
    picked AS MATERIALIZED (
      SELECT id FROM jobs
      WHERE status = 'queued' AND id IN (SELECT id FROM ranked WHERE rn <= room)
      ORDER BY priority ASC, run_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs SET status = 'running', locked_by = ${workerId}, locked_at = now(),
      started_at = COALESCE(started_at, now()), attempts = attempts + 1, updated_at = now()
    FROM picked
    WHERE jobs.id = picked.id
    RETURNING jobs.id`);
  const ids = (rows as unknown as Array<{ id: string }>).map((r) => r.id);
  if (!ids.length) return [];
  return db.select().from(jobs).where(inArray(jobs.id, ids));
}

export async function completeJob(id: string, result: unknown) {
  await db
    .update(jobs)
    .set({ status: "succeeded", result: result ?? null, finishedAt: new Date(), lockedBy: null, lastError: null })
    .where(eq(jobs.id, id));
}

export async function failJob(job: JobRow, error: unknown, retryable = true) {
  const message = error instanceof Error ? `${error.message}` : String(error);
  const canRetry = retryable && job.attempts < job.maxAttempts;
  const backoffMs = Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, job.attempts - 1));
  await db
    .update(jobs)
    .set(
      canRetry
        ? { status: "queued", runAt: new Date(Date.now() + backoffMs), lockedBy: null, lastError: message }
        : { status: "failed", finishedAt: new Date(), lockedBy: null, lastError: message },
    )
    .where(eq(jobs.id, job.id));
}

/** Re-queues jobs whose worker died (locked for too long). */
export async function recoverStaleJobs(staleAfterMs = 15 * 60_000) {
  const secs = Math.round(staleAfterMs / 1000);
  // Jobs whose worker died (no heartbeat): retry if attempts remain, otherwise fail them.
  await db.execute(sql`
    UPDATE jobs SET status = 'failed', locked_by = NULL, finished_at = now(), updated_at = now(),
      last_error = COALESCE(last_error, 'Worker stopped while the job was running')
    WHERE status = 'running' AND locked_at < now() - (${secs} || ' seconds')::interval AND attempts >= max_attempts`);
  await db.execute(sql`
    UPDATE jobs SET status = 'queued', locked_by = NULL, updated_at = now()
    WHERE status = 'running' AND locked_at < now() - (${secs} || ' seconds')::interval AND attempts < max_attempts`);
}
