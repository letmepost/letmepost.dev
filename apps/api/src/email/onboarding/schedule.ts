import { emailEnabled } from "../client.js";
import {
  getOnboardingEmailQueue,
  type OnboardingEmailJobData,
} from "../../queue/queues.js";

type ScheduleInput = {
  userId: string;
  email: string;
  firstName: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Fan-out the onboarding sequence by enqueueing one delayed job per
// email. Idempotent: a stable jobId per (user, kind) means a duplicate
// call (e.g. better-auth firing the hook twice on retry) lands on
// `onConflictDoNothing` semantics in BullMQ. Skips entirely when
// RESEND_API_KEY or EMAIL_FROM is missing — checked once at enqueue
// instead of per-job so we don't generate worker DLQ noise in
// misconfigured prod environments.
export async function scheduleOnboardingEmails(
  input: ScheduleInput,
): Promise<void> {
  if (!emailEnabled()) return;
  const queue = getOnboardingEmailQueue();

  const schedule: Array<{
    kind: OnboardingEmailJobData["kind"];
    delayDays: number;
  }> = [
    { kind: "d0_welcome", delayDays: 0 },
    { kind: "d1_first_post", delayDays: 1 },
    { kind: "d3_stuck", delayDays: 3 },
    { kind: "d5_webhooks", delayDays: 5 },
    { kind: "d7_one_question", delayDays: 7 },
  ];

  await Promise.all(
    schedule.map(({ kind, delayDays }) =>
      queue.add(
        kind,
        {
          userId: input.userId,
          email: input.email,
          firstName: input.firstName,
          kind,
        },
        {
          // jobId scoped to (user, kind) makes the enqueue idempotent.
          // BullMQ rejects duplicate ids by default.
          jobId: `onboarding:${input.userId}:${kind}`,
          delay: delayDays * ONE_DAY_MS,
        },
      ).catch((err: unknown) => {
        // Duplicate jobId is the expected path on retry; everything
        // else is logged but doesn't fail the caller's request — we
        // don't want a Redis hiccup to brick signup.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.toLowerCase().includes("duplicate")) {
          console.warn(
            `[onboarding] failed to enqueue ${kind} for ${input.userId}: ${message}`,
          );
        }
      }),
    ),
  );
}
