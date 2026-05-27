import { Resend } from "resend";
import { LetmepostError } from "../errors.js";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "RESEND_API_KEY is not configured.",
    });
  }
  _resend = new Resend(key);
  return _resend;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  // Plain-text body. We intentionally don't ship an HTML alternative —
  // onboarding emails are styled to look like personal one-to-one notes
  // from the founder, not transactional blasts. Resend treats text-only
  // emails identically to text+HTML for delivery.
  text: string;
  replyTo?: string;
  // Optional tag for filtering in the Resend dashboard / webhooks.
  tag?: string;
};

// Send a single transactional email. Returns the Resend message id on
// success so the caller can stamp it on whatever audit row (e.g.
// onboarding_emails.resend_id) needs to dedupe replays.
export async function sendEmail(input: SendEmailInput): Promise<string> {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new LetmepostError({
      code: "internal_error",
      status: 500,
      message: "EMAIL_FROM is not configured.",
    });
  }
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.tag ? { tags: [{ name: "kind", value: input.tag }] } : {}),
  });
  if (error || !data) {
    throw new LetmepostError({
      code: "platform_unavailable",
      status: 502,
      message: `Resend rejected the email: ${error?.message ?? "unknown error"}`,
      platform: "resend",
      platformResponse: error,
    });
  }
  return data.id;
}
