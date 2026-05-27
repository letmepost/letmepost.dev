import { eq } from "drizzle-orm";
import type { DrizzleClient } from "../../db/index.js";
import { member } from "../../db/schema/auth.js";
import { platformAccounts } from "../../db/schema/platform_accounts.js";
import { posts } from "../../db/schema/posts.js";
import { webhookEndpoints } from "../../db/schema/webhook_endpoints.js";
import type { OnboardingEmailJobData } from "../../queue/queues.js";
import { sendEmail } from "../client.js";
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

// Pull a concise picture of "how far has this user gotten" from the
// member's primary org. We use the first org membership rather than
// `activeOrganizationId` since the user might not have a session at
// the moment the worker fires; the rows are scoped per-org and the
// signups flow always creates a personal org alongside the user.
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

  const [a] = await db
    .select({ id: platformAccounts.id })
    .from(platformAccounts)
    .where(eq(platformAccounts.organizationId, orgId))
    .limit(1);
  const [p] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.organizationId, orgId))
    .limit(1);
  const [w] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, orgId))
    .limit(1);

  return {
    hasAccount: Boolean(a),
    hasPost: Boolean(p),
    hasWebhook: Boolean(w),
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

export async function processOnboardingEmail(
  db: DrizzleClient,
  job: OnboardingEmailJobData,
): Promise<{ sent: boolean; reason?: string; resendId?: string }> {
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
  });
  return { sent: true, resendId };
}

// Exposed for unit testing — `shouldSend` is the core decision matrix.
export const __testing = { shouldSend, readUserState };
