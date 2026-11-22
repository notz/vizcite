import { afterAll, describe, expect, it } from "vitest";
import { inArray, like } from "drizzle-orm";
import { db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { claimJobs, enqueueJob, failJob } from "./queue";

// Runs against the dev/CI Postgres. Test job types are unique, so real jobs are never claimed.
const T = `qtest-${Date.now()}`;
const make = (type: string, n: number) => Promise.all(Array.from({ length: n }, () => enqueueJob(type)));

afterAll(async () => {
  await db.delete(jobs).where(like(jobs.type, `${T}%`));
});

describe("claimJobs", () => {
  it("never gives one type more than its room", async () => {
    await make(`${T}-a`, 6);
    const got = await claimJobs("w1", { [`${T}-a`]: 2 }, 10);
    expect(got).toHaveLength(2);
    expect(await claimJobs("w1", { [`${T}-a`]: 0 }, 10)).toHaveLength(0);
  });

  it("two workers claiming at once never get the same job", async () => {
    await make(`${T}-b`, 6);
    const room = { [`${T}-b`]: 6 };
    const [x, y] = await Promise.all([claimJobs("w1", room, 4), claimJobs("w2", room, 4)]);
    const ids = [...x, ...y].map((j) => j.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe("failJob", () => {
  it("requeues with a delay while attempts remain, then fails", async () => {
    const type = `${T}-c`;
    await enqueueJob(type, {}, { maxAttempts: 2 });
    const [first] = await claimJobs("w1", { [type]: 1 }, 1);
    await failJob(first!, new Error("boom"));
    const [after] = await db.select().from(jobs).where(inArray(jobs.id, [first!.id]));
    expect(after!.status).toBe("queued");
    expect(after!.runAt.getTime()).toBeGreaterThan(Date.now());
    await failJob({ ...first!, attempts: 2 }, new Error("boom"));
    const [done] = await db.select().from(jobs).where(inArray(jobs.id, [first!.id]));
    expect(done!.status).toBe("failed");
  });
});
