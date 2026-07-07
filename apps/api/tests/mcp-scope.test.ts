import { describe, expect, it } from "vitest";
import { authorizeToolCall, toolRequiresPublish } from "../src/routes/mcp.js";

// Real tool names projected from the OpenAPI spec by the autogen layer. Every
// name is `<httpMethod>_<slug>`; only GETs are read-only.
const WRITE_TOOLS = [
  "post_v1_posts", // publish / schedule a post
  "delete_v1_posts_by_id", // cancel a queued post
  "patch_v1_posts_by_id", // reschedule a queued post
  "post_v1_accounts_connect_by_platform", // mutate account state
  "delete_v1_accounts_by_id", // disconnect an account
  "post_v1_webhook_endpoints", // register a webhook
  "delete_v1_webhook_endpoints_by_id", // delete a webhook
  "patch_v1_accounts_by_id_pinterest_default_board",
];

const READ_TOOLS = [
  "get_v1_posts",
  "get_v1_posts_by_id",
  "get_v1_accounts",
  "get_v1_accounts_by_id",
  "get_v1_webhook_endpoints",
  "get_v1_media",
];

describe("toolRequiresPublish (classification)", () => {
  it("classifies every mutating tool as write/publish", () => {
    for (const name of WRITE_TOOLS) {
      expect(toolRequiresPublish(name), name).toBe(true);
    }
  });

  it("classifies every GET tool as read-only", () => {
    for (const name of READ_TOOLS) {
      expect(toolRequiresPublish(name), name).toBe(false);
    }
  });

  it("fails safe: an unknown / unmapped tool name requires publish", () => {
    expect(toolRequiresPublish("some_future_tool")).toBe(true);
    expect(toolRequiresPublish("")).toBe(true);
    expect(toolRequiresPublish("execute_arbitrary")).toBe(true);
  });
});

describe("authorizeToolCall (enforcement)", () => {
  it("denies a read-only-scoped token calling a publish tool", () => {
    const decision = authorizeToolCall("post_v1_posts", ["read"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain("publish");
    }
  });

  it("allows a publish-scoped token calling a publish tool", () => {
    expect(authorizeToolCall("post_v1_posts", ["publish"]).allowed).toBe(true);
    expect(
      authorizeToolCall("delete_v1_posts_by_id", ["read", "publish"]).allowed,
    ).toBe(true);
  });

  it("allows a read tool with the read scope", () => {
    expect(authorizeToolCall("get_v1_posts", ["read"]).allowed).toBe(true);
  });

  it("allows a read tool with only the publish scope", () => {
    expect(authorizeToolCall("get_v1_posts", ["publish"]).allowed).toBe(true);
  });

  it("denies a read tool when the token carries neither read nor publish", () => {
    const decision = authorizeToolCall("get_v1_posts", ["openid"]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain("read");
    }
  });

  it("denies an unknown/unmapped tool unless publish is present (fail-safe)", () => {
    expect(authorizeToolCall("some_future_tool", ["read"]).allowed).toBe(false);
    expect(authorizeToolCall("some_future_tool", ["publish"]).allowed).toBe(
      true,
    );
  });

  it("bypasses OAuth scope checks for the API-key path (scopes === null)", () => {
    // API keys carry no OAuth consent scopes; apiKeyAuth() enforces downstream.
    expect(authorizeToolCall("post_v1_posts", null).allowed).toBe(true);
    expect(authorizeToolCall("delete_v1_posts_by_id", null).allowed).toBe(true);
    expect(authorizeToolCall("get_v1_posts", null).allowed).toBe(true);
  });
});
