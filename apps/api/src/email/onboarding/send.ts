import { eq, sql } from "drizzle-orm";
import type { DrizzleClient } from "../../db/index.js";
import { user as userTable } from "../../db/schema/auth.js";
import { member } from "../../db/schema/auth.js";
import { emailSuppressions } from "../../db/schema/email_suppressions.js";
import { platformAccounts } from "../../db/schema/platform_accounts.js";
import { posts } from "../../db/schema/posts.js";
import { webhookEndpoints } from "../../db/schema/webhook_endpoints.js";
import type { OnboardingEmailJobData } from "../../queue/queues.js";
import { emailEnabled, sendEmail } from "../client.js";
import {
  firstPost,
  oneQuestion,
  stuckCheck,
  webhooks,
  welcome,
  type OnboardingUser,
} from "./templates.js";

type UserState = {
  hasAccount: boolean;
  hasPost: boolean;
  hasWebhook: boolean;
};

// Single-roundtrip rollup of "how far has this user gotten". The CTE
// pins the member's primary org once; the EXISTS clauses run as
// correlated subqueries on the same connection. Cheaper than four
// sequential round-trips when launch traffic spikes.
async function readUserState(
  db: DrizzleClient,
  userId: string,
): Promise<UserState> {
  const [m] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  if (!m) return { hasAccount: false, hasPost: false, hasWebhook: false };
  const orgId = m.organizationId;

  // `db.execute` returns a driver-shaped result: postgres-js gives a
  // `RowList` (array-like) and pg gives `{ rows }`. We coerce to a
  // generic array of records so the downstream read works on both.
  const result = (await db.execute<{
    has_account: boolean;
    has_post: boolean;
    has_webhook: boolean;
  }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM ${platformAccounts}
              WHERE ${platformAccounts.organizationId} = ${orgId}) AS has_account,
      EXISTS (SELECT 1 FROM ${posts}
              WHERE ${posts.organizationId} = ${orgId}) AS has_post,
      EXISTS (SELECT 1 FROM ${webhookEndpoints}
              WHERE ${webhookEndpoints.organizationId} = ${orgId}) AS has_webhook
  `)) as unknown as {
    rows?: Array<{
      has_account: boolean;
      has_post: boolean;
      has_webhook: boolean;
    }>;
    0?: { has_account: boolean; has_post: boolean; has_webhook: boolean };
  };
  const row = result.rows ? result.rows[0] : result[0];
  return {
    hasAccount: Boolean(row?.has_account),
    hasPost: Boolean(row?.has_post),
    hasWebhook: Boolean(row?.has_webhook),
  };
}

// Decide whether the given email kind should fire given the user's
// state. Returns null when the email should be skipped.
//
// The shapes here mirror the conditional behaviour we want without
// requiring branching inside the templates themselves:
//
//   d0_welcome      always sends
//   d1_first_post   skip if user already has an account connected
//   d3_stuck        skip if user already has an account connected
//   d5_webhooks     skip unless user has posted AND not yet registered a webhook
//   d7_one_question always sends
function shouldSend(
  kind: OnboardingEmailJobData["kind"],
  state: UserState,
): boolean {
  switch (kind) {
    case "d0_welcome":
      return true;
    case "d1_first_post":
      return !state.hasAccount;
    case "d3_stuck":
      return !state.hasAccount;
    case "d5_webhooks":
      return state.hasPost && !state.hasWebhook;
    case "d7_one_question":
      return true;
  }
}

function pickTemplate(
  kind: OnboardingEmailJobData["kind"],
  user: OnboardingUser,
) {
  switch (kind) {
    case "d0_welcome":
      return welcome(user);
    case "d1_first_post":
      return firstPost(user);
    case "d3_stuck":
      return stuckCheck(user);
    case "d5_webhooks":
      return webhooks(user);
    case "d7_one_question":
      return oneQuestion(user);
  }
}

// Lower-case for the PK lookup so casing differences ("Foo@example.com"
// vs "foo@example.com") collapse onto the same suppression row.
async function isSuppressed(
  db: DrizzleClient,
  email: string,
): Promise<boolean> {
  const [row] = await db
    .select({ email: emailSuppressions.email })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, email.toLowerCase()))
    .limit(1);
  return Boolean(row);
}

async function userExists(
  db: DrizzleClient,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  return Boolean(row);
}

export async function processOnboardingEmail(
  db: DrizzleClient,
  job: OnboardingEmailJobData,
): Promise<{ sent: boolean; reason?: string; resendId?: string }> {
  // Belt-and-braces against jobs that bypass the schedule gate (manual
  // enqueue, replay tooling, jobs queued before Resend keys were
  // unset). Without this the worker would 500 + DLQ on every attempt.
  if (!emailEnabled()) {
    return { sent: false, reason: "email_disabled" };
  }

  // User-deleted-between-d0-and-d7 case. Verification gating in
  // auth.ts protects against fresh signups, but doesn't cover a user
  // who signed up, got their first emails, then deleted their account.
  if (!(await userExists(db, job.userId))) {
    return { sent: false, reason: "user_deleted" };
  }

  // Honor opt-outs and hard bounces written by the Resend webhook
  // handler. Cheap PK lookup on text.
  if (await isSuppressed(db, job.email)) {
    return { sent: false, reason: "suppressed" };
  }

  const state = await readUserState(db, job.userId);
  if (!shouldSend(job.kind, state)) {
    return { sent: false, reason: "state_skip" };
  }
  const template = pickTemplate(job.kind, {
    firstName: job.firstName,
    email: job.email,
  });
  const replyTo = process.env.EMAIL_REPLY_TO ?? process.env.EMAIL_FROM;
  const resendId = await sendEmail({
    to: job.email,
    subject: template.subject,
    text: template.text,
    ...(replyTo ? { replyTo } : {}),
    tag: job.kind,
    // Mandatory for Gmail/Yahoo (Feb 2024 sender rules) and the right
    // default anyway — users can hit reply to opt out and the founder
    // will see it.
    withUnsubscribe: true,
    // At-least-once delivery: BullMQ can re-run a job if the worker
    // crashes between sendEmail and the queue ack. Resend dedupes on
    // Idempotency-Key (24h window) so the recipient sees the message
    // exactly once even on a worker retry.
    idempotencyKey: `onboarding:${job.userId}:${job.kind}`,
  });
  return { sent: true, resendId };
}

// Exposed for unit testing — `shouldSend` is the core decision matrix.
export const __testing = { shouldSend, readUserState };
