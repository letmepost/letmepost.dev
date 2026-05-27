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

// True when both Resend keys are set. Cheap boot-time check so callers
// can skip enqueueing entirely instead of generating per-job 500s when
// EMAIL_FROM (or RESEND_API_KEY) is missing in prod.
export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

// Mailto unsubscribe address per RFC 8058. Defaults to EMAIL_FROM so
// replies land in the founder's inbox; override when EMAIL_FROM is a
// no-reply.
function unsubscribeAddress(): string | null {
  const raw = process.env.EMAIL_UNSUBSCRIBE_MAILTO ?? process.env.EMAIL_FROM;
  if (!raw) return null;
  // Resend's `from` field allows a "Display Name <addr>" form; the mailto
  // header wants just the address part.
  const match = raw.match(/<([^>]+)>/);
  return match?.[1] ?? raw;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  // Plain-text body. We intentionally don't ship an HTML alternative —
  // onboarding emails are styled to look like personal one-to-one notes
  // from the founder, not transactional blasts.
  text: string;
  replyTo?: string;
  // Optional kind tag, surfaced as `kind` in the Resend dashboard so
  // sequence-specific debugging is filterable.
  tag?: string;
  // Set to true to add a mailto List-Unsubscribe header. Valid under
  // RFC 2369; we deliberately skip the RFC 8058 one-click POST hint
  // until we ship a token-backed HTTPS endpoint.
  withUnsubscribe?: boolean;
  // Resend dedupe key (24h window). Stable across worker retries so a
  // mid-send crash doesn't produce a second copy in the recipient's
  // inbox. Derived per-caller — e.g. `onboarding:<userId>:<kind>`.
  idempotencyKey?: string;
};

// Send a single transactional email. Returns the Resend message id on
// success so the caller can stamp it on whatever audit row needs to
// dedupe replays.
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

  const headers: Record<string, string> = {};
  if (input.withUnsubscribe) {
    const addr = unsubscribeAddress();
    if (addr) {
      // Mailto-only List-Unsubscribe is a valid RFC 2369 implementation
      // that Gmail and Yahoo accept. We deliberately do NOT add
      // `List-Unsubscribe-Post: List-Unsubscribe=One-Click` because
      // RFC 8058 §3.1 requires that header to point at an HTTPS URL,
      // which we haven't shipped a token-backed endpoint for yet.
      // Misconfigured one-click is worse than mailto-only.
      headers["List-Unsubscribe"] = `<mailto:${addr}?subject=unsubscribe>`;
    }
  }

  const envTag =
    process.env.SENTRY_ENV ?? process.env.NODE_ENV ?? "development";
  const tags = [
    ...(input.tag ? [{ name: "kind", value: input.tag }] : []),
    { name: "env", value: envTag },
  ];

  const { data, error } = await resend.emails.send(
    {
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      tags,
    },
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
  );
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
