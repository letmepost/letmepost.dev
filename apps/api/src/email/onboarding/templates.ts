// Onboarding email content. Plain-text only, written to read like a
// personal note from the founder — lowercase subjects, casual greeting,
// no HTML, no logo, no styling, no marketing fluff. The example we're
// matching is the MediaFast "everything alright?" pattern.
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

// D0 — sent immediately after signup. Always sends. Plants the
// "reply if stuck" expectation up front.
export function welcome(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "you're in",
    text: `Hey ${user.firstName},

Saw you signed up for letmepost. I'm Rose, building this solo from India.

Three things in case you missed them:

1. Connect your first account: https://dashboard.letmepost.dev/accounts
2. Docs (start with the curl example): https://docs.letmepost.dev
3. MCP server if you want your AI agent to post: https://docs.letmepost.dev/mcp

If you get stuck, hit reply. I read every one of these myself.

Rose`,
  };
}

// D1 — your first post. Concrete curl. Sent only if the user hasn't
// connected an account yet (worker checks; this template doesn't).
export function firstPost(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "your first letmepost in 30 seconds",
    text: `Hey ${user.firstName},

The fastest way to see letmepost work end-to-end:

1. Connect a Bluesky account (10 seconds — just an app password): https://dashboard.letmepost.dev/accounts
2. Grab an API key: https://dashboard.letmepost.dev/api-keys
3. Run this:

curl -X POST https://api.letmepost.dev/v1/posts \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "hello from letmepost", "targets": [{"platform": "bluesky"}]}'

That's it. If something breaks, the error tells you exactly why and which preflight rule failed. That's the whole pitch.

Rose`,
  };
}

// D3 — stuck check. Sent only if the user hasn't connected ANY account.
// This is the highest-signal qual-feedback email — closely modeled on
// the MediaFast "everything alright?" prompt.
export function stuckCheck(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "everything alright?",
    text: `Hey ${user.firstName},

Saw you signed up for letmepost but haven't connected an account yet.

Totally fine, just wanted to check if everything's alright or if something seemed off. Was it the docs, the setup flow, a missing platform, or just not what you expected?

Even one line helps. I read every reply myself and it directly shapes what I build next.

Rose`,
  };
}

// D5 — webhooks. Sent only if the user has posts but no webhook
// endpoint yet. Webhooks are the retention hook — once an integrator
// is listening for post.published, they stay.
export function webhooks(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "you'll want webhooks",
    text: `Hey ${user.firstName},

Posts publish async — letmepost queues them, hits the platform, and writes the result back. Polling our API works but webhooks are better.

Setup:

1. Dashboard → Webhooks → New endpoint
2. Subscribe to post.published and post.failed at minimum
3. We sign every payload HMAC-SHA256, verifier examples in the docs: https://docs.letmepost.dev/webhooks

Most people skip this for a week then wish they hadn't. Just a heads up.

Rose`,
  };
}

// D7 — one question. Always sends to anyone who made it this far.
// Designed to bait a reply.
export function oneQuestion(user: OnboardingUser): OnboardingTemplate {
  return {
    subject: "one question",
    text: `Hey ${user.firstName},

It's been a week since you signed up for letmepost.

Two quick questions if you have 30 seconds:

1. What's the one thing that's been frustrating or confusing?
2. If letmepost vanished tomorrow, would you miss it?

That's it. Solo founder, every reply lands in my inbox, and your answer literally changes the roadmap.

Rose`,
  };
}
