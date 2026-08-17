import { describe, expect, it } from "vitest";
import { publishJobId } from "../src/queue/enqueue.js";
import { jobIdFor } from "../src/queue/refresh-enqueue.js";

/**
 * Guards the BullMQ custom-job-id contract.
 *
 * `publishJobId` used to return `publish:<uuid>`. BullMQ rejects a custom job
 * id containing `:` unless it splits into exactly three parts, so every
 * scheduled-post enqueue threw "Custom Id cannot contain :" — the posts row
 * was already committed, so it sat `queued` forever with no delivery attempt
 * while the caller got a 500. Scheduled publishing was down entirely.
 *
 * Nothing caught it because every route test injects a stub enqueuer, so the
 * real id never met the real validator — and BullMQ only validates inside
 * `job.addJob()`, which needs a live Redis client. These tests mirror the
 * rule instead, and assert the property that actually keeps us safe: no colon
 * in the id at all, rather than relying on the three-part escape hatch that
 * BullMQ has marked for removal.
 */

const UUID = "0198c5f3-6f7a-7c3e-9a1b-2f4d6e8a0b12";

/** Mirrors bullmq's check in `classes/job.js`. */
function isRejectedByBullMq(jobId: string): boolean {
  if (`${Number.parseInt(jobId, 10)}` === jobId) return true;
  return jobId.includes(":") && jobId.split(":").length !== 3;
}

describe("publishJobId", () => {
  it("produces an id BullMQ accepts", () => {
    const id = publishJobId(UUID);
    expect(id).not.toContain(":");
    expect(isRejectedByBullMq(id)).toBe(false);
  });

  it("is stable, so remove() and enqueue() address the same job", () => {
    expect(publishJobId(UUID)).toBe(publishJobId(UUID));
    expect(publishJobId(UUID)).not.toBe(publishJobId("other-id"));
  });

  it("no longer uses the colon form that BullMQ rejected", () => {
    // The shipped bug, pinned: `publish:<uuid>` splits into two parts, which
    // is exactly what BullMQ refuses.
    expect(isRejectedByBullMq(`publish:${UUID}`)).toBe(true);
    expect(publishJobId(UUID)).not.toBe(`publish:${UUID}`);
  });
});

describe("refresh jobIdFor", () => {
  it("produces an id BullMQ accepts", () => {
    const id = jobIdFor(UUID, 1_760_000_000_000);
    expect(id).not.toContain(":");
    expect(isRejectedByBullMq(id)).toBe(false);
  });
});
