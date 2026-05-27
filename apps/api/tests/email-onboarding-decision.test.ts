import { describe, expect, it } from "vitest";
import { __testing } from "../src/email/onboarding/send.js";
import { ONBOARDING_EMAIL_KINDS } from "../src/queue/queues.js";

const { shouldSend } = __testing;

type State = { hasAccount: boolean; hasPost: boolean; hasWebhook: boolean };

// Single source of truth lives in queues.ts so adding a new email kind
// automatically extends the smoke-test below.
const ALL_KINDS = ONBOARDING_EMAIL_KINDS;

// Every combination of (hasAccount, hasPost, hasWebhook). hasPost without
// hasAccount is unreachable in practice (you can't post without an
// account) but the decision matrix should still handle it safely.
function allStates(): State[] {
  const states: State[] = [];
  for (const a of [false, true]) {
    for (const p of [false, true]) {
      for (const w of [false, true]) {
        states.push({ hasAccount: a, hasPost: p, hasWebhook: w });
      }
    }
  }
  return states;
}

describe("email/onboarding shouldSend", () => {
  describe("d0_welcome", () => {
    it("always sends", () => {
      for (const s of allStates()) {
        expect(shouldSend("d0_welcome", s)).toBe(true);
      }
    });
  });

  describe("d7_one_question", () => {
    it("always sends", () => {
      for (const s of allStates()) {
        expect(shouldSend("d7_one_question", s)).toBe(true);
      }
    });
  });

  describe("d1_first_post", () => {
    it("skips users who already connected an account", () => {
      for (const s of allStates()) {
        expect(shouldSend("d1_first_post", s)).toBe(!s.hasAccount);
      }
    });
  });

  describe("d3_stuck", () => {
    it("skips users who already connected an account", () => {
      for (const s of allStates()) {
        expect(shouldSend("d3_stuck", s)).toBe(!s.hasAccount);
      }
    });
  });

  describe("d5_webhooks", () => {
    it("only sends when posts exist and no webhook yet", () => {
      for (const s of allStates()) {
        expect(shouldSend("d5_webhooks", s)).toBe(
          s.hasPost && !s.hasWebhook,
        );
      }
    });
  });

  it("covers every kind", () => {
    const empty = { hasAccount: false, hasPost: false, hasWebhook: false };
    // Smoke test that no kind throws and every kind returns a boolean.
    for (const k of ALL_KINDS) {
      const out = shouldSend(k, empty);
      expect(typeof out).toBe("boolean");
    }
  });
});
