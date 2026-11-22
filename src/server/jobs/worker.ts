import "server-only";
import os from "node:os";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { db, rawSql } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { getSetting } from "@/server/settings";
import { claimJobs, completeJob, failJob, recoverStaleJobs, setJobProgress, type JobRow } from "./queue";
import { getHandlers, getSchedules } from "./define";
import "./registry";

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const running = new Map<string, number>(); // type → count
let started = false;
let stopping = false;

class TimeoutError extends Error {}
const STOP_GRACE_MS = 30_000;

async function runOne(job: JobRow) {
  const handler = getHandlers().get(job.type);
  if (!handler) {
    await failJob(job, new Error(`No handler registered for job type "${job.type}"`), false);
    return;
  }
  running.set(job.type, (running.get(job.type) ?? 0) + 1);
  const started = Date.now();
  const timeoutMs = handler.timeoutMs ?? 15 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  // Heartbeat: keeps `locked_at` fresh so stale-job recovery only picks up jobs whose worker died.
  const heartbeat = setInterval(() => {
    void db
      .update(jobs)
      .set({ lockedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .catch(() => {});
  }, 60_000);
  let work: Promise<unknown> | undefined;
  try {
    work = handler.run(job.payload as never, {
      job,
      signal: abort.signal,
      progress: (p) => setJobProgress(job.id, p),
      isCancelled: async () => {
        if (abort.signal.aborted) return true;
        const [row] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.id)).limit(1);
        return row?.status === "cancelled";
      },
      log: (...args) => console.info(`[job:${job.type}:${job.id}]`, ...args),
    });
    const result = await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
    const [row] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.id)).limit(1);
    if (row?.status !== "cancelled") await completeJob(job.id, result);
    console.info(`[jobs] ✓ ${job.type} ${job.id} (${Date.now() - started}ms)`);
  } catch (err) {
    console.error(`[jobs] ✗ ${job.type} ${job.id}:`, err instanceof Error ? err.message : err);
    if (err instanceof TimeoutError && work) {
      // Tell the handler to stop and give it a moment, so a retry doesn't run next to the old attempt.
      abort.abort();
      await Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
    }
    await failJob(job, err, handler.retryable !== false);
  } finally {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    running.set(job.type, Math.max(0, (running.get(job.type) ?? 1) - 1));
  }
}

async function pollOnce() {
  const limits = await getSetting("limits");
  const totalRunning = [...running.values()].reduce((a, b) => a + b, 0);
  const capacity = limits.jobConcurrency - totalRunning;
  if (capacity <= 0) return;
  const room: Record<string, number> = {};
  for (const [type, h] of getHandlers()) room[type] = (h.concurrency ?? 2) - (running.get(type) ?? 0);
  const claimed = await claimJobs(WORKER_ID, room, capacity);
  for (const job of claimed) void runOne(job);
}

async function loop() {
  while (!stopping) {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[jobs] poll error", err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function startScheduler() {
  for (const schedule of getSchedules().values()) {
    new Cron(schedule.cron, { timezone: "UTC", protect: true }, async () => {
      // Only one process runs schedules (advisory lock), so replicas don't double-enqueue.
      // Session locks belong to one connection, so lock, tick and unlock share one reserved connection.
      const lockId = hashName(schedule.name);
      const conn = await rawSql.reserve();
      try {
        const [res] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${lockId}) AS locked`;
        if (!res?.locked) return;
        try {
          await schedule.tick();
        } catch (err) {
          console.error(`[scheduler] ${schedule.name} failed`, err);
        } finally {
          await conn`SELECT pg_advisory_unlock(${lockId})`;
        }
      } finally {
        conn.release();
      }
    });
  }
  console.info(`[scheduler] ${getSchedules().size} schedules active`);
}

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return h;
}

export async function startWorker() {
  if (started) return;
  started = true;
  await recoverStaleJobs(5 * 60_000).catch(() => {});
  setInterval(() => void recoverStaleJobs(5 * 60_000).catch(() => {}), 2 * 60_000);
  startScheduler();
  void loop();
  console.info(`[jobs] worker ${WORKER_ID} started with ${getHandlers().size} handlers`);
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
