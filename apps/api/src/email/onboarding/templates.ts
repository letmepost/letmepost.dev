// Onboarding email content. Plain-text only, written to read like a
// personal note from the founder: lowercase subjects, casual greeting,
// no HTML, no logo, no styling. The wedge ("failure is loud, not
// silent") threads through D0, D1, D5 deliberately so each email
// reinforces the same brand image.
//
// Each template is a pure function of the user's current state; the
// worker decides whether to send based on the same state.

export type OnboardingUser = {
  firstName: string;
  email: string;
};

export type OnboardingTemplate = {
  subject: string;
  text: string;
};

// D0 - sent immediately after signup (for OAuth users) or after email
// verification (for email/password users). Leads with the 30-second
// path and the loud-failure wedge so the first email plants both.
export function welcome(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "30 seconds to your first letmepost post",
    text: `Hey ${user.firstName},

You're verified. Here's the fastest path to seeing it work:

  curl -X POST https://api.letmepost.dev/v1/posts \\
    -H "Authorization: Bearer YOUR_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"text": "hello", "targets": [{"platform": "bluesky"}]}'

You'll need two things first:

  1. A Bluesky account connected (10 seconds, just an app password): https://dashboard.letmepost.dev/accounts
  2. An API key: https://dashboard.letmepost.dev/api-keys

If anything breaks, the error response tells you exactly which preflight rule failed and how to fix it. That's the whole pitch. No silent failures, no opaque 500s.

I'm Kamal, building letmepost solo. If you get stuck, hit reply. I read every one of these myself.

Kamal`,
  };
}

// D1 - sent only if no account is connected yet (worker checks).
// Reinforces the same proof point as D0 in case the user skimmed past
// it the first time.
export function firstPost(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "your first letmepost in 30 seconds",
    text: `Hey ${user.firstName},

Three commands. No SDK install.

  1. Connect Bluesky (10 seconds, app password): https://dashboard.letmepost.dev/accounts
  2. Grab an API key: https://dashboard.letmepost.dev/api-keys
  3. POST:

curl -X POST https://api.letmepost.dev/v1/posts \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "hello from letmepost", "targets": [{"platform": "bluesky"}]}'

If something breaks, the error tells you exactly which preflight rule failed and how to fix it. That's the whole pitch.

Kamal`,
  };
}

// D3 - stuck check. Sent only if the user hasn't connected ANY account.
// Highest-signal qual-feedback email, modeled on the MediaFast
// "everything alright?" pattern. Don't overthink it.
export function stuckCheck(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "everything alright?",
    text: `Hey ${user.firstName},

Saw you signed up for letmepost but haven't connected an account yet.

Just wanted to check, was it the docs, the setup flow, a missing platform, or something else? Even one line helps. I read every reply and it shapes what I build next.

Kamal`,
  };
}

// D5 - webhooks. Sent only if the user has posts but no webhook
// endpoint yet. Leads with a specific number so the subject is itself a
// curiosity hook AND the proof point Ogilvy demands.
export function webhooks(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "8,640 polls per post, or one webhook",
    text: `Hey ${user.firstName},

Polling /v1/posts/:id every 10 seconds to find out when a post actually published costs 8,640 requests per post per day. A single webhook delivery handles it forever.

  1. Dashboard → Webhooks → New endpoint
  2. Subscribe to post.published and post.failed
  3. Verify with HMAC-SHA256 (verifier examples in the docs): https://docs.letmepost.dev/webhooks

Most people skip this their first week, then move it to the top of the backlog the day a customer reports a stuck post they can't track. Worth doing now.

Kamal`,
  };
}

// D7 - Sean Ellis PMF question. Always sends to anyone who made it
// this far. Subject IS the question - body asks it once. Three-bucket
// framing forces a stance with low effort, lifting reply rate.
export function oneQuestion(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "would you miss it?",
    text: `Hey ${user.firstName},

It's been a week since you signed up for letmepost.

One question if you have 30 seconds: if letmepost vanished tomorrow, would you miss it? A lot, a little, or not at all?

Solo founder, every reply lands in my inbox, and your answer literally changes the roadmap.

Kamal`,
  };
}
