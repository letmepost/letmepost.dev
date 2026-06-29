import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMetaSignedRequest } from "../src/webhooks/meta-signed-request.js";

const SECRET = "fb_app_secret_test_value";

function base64Url(buf: Buffer | string): string {
  return (typeof buf === "string" ? Buffer.from(buf, "utf8") : buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeSignedRequest(
  payload: Record<string, unknown>,
  secret = SECRET,
): string {
  const encodedPayload = base64Url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(encodedPayload).digest();
  return `${base64Url(sig)}.${encodedPayload}`;
}

describe("parseMetaSignedRequest", () => {
  const validPayload = {
    algorithm: "HMAC-SHA256",
    user_id: "1234567890",
    issued_at: 1746000000,
  };

  it("accepts a well-formed signed_request and returns the payload", () => {
    const sr = makeSignedRequest(validPayload);
    const result = parseMetaSignedRequest(sr, SECRET);
    expect(result).not.toBeNull();
    expect(result?.user_id).toBe("1234567890");
    expect(result?.algorithm).toBe("HMAC-SHA256");
  });

  it("rejects a request signed with the wrong secret", () => {
    const sr = makeSignedRequest(validPayload, "wrong_secret");
    expect(parseMetaSignedRequest(sr, SECRET)).toBeNull();
  });

  it("rejects a payload with the wrong algorithm", () => {
    const sr = makeSignedRequest({
      ...validPayload,
      algorithm: "HMAC-SHA1",
    });
    expect(parseMetaSignedRequest(sr, SECRET)).toBeNull();
  });

  it("rejects a payload missing user_id", () => {
    const sr = makeSignedRequest({ algorithm: "HMAC-SHA256" });
    expect(parseMetaSignedRequest(sr, SECRET)).toBeNull();
  });

  it("rejects a payload with an empty user_id", () => {
    const sr = makeSignedRequest({
      algorithm: "HMAC-SHA256",
      user_id: "",
    });
    expect(parseMetaSignedRequest(sr, SECRET)).toBeNull();
  });

  it("rejects malformed inputs without throwing", () => {
    expect(parseMetaSignedRequest("", SECRET)).toBeNull();
    expect(parseMetaSignedRequest("nodot", SECRET)).toBeNull();
    expect(parseMetaSignedRequest(".", SECRET)).toBeNull();
    expect(parseMetaSignedRequest("a.b.c", SECRET)).toBeNull();
    expect(parseMetaSignedRequest("not-base64.{}", SECRET)).toBeNull();
  });

  it("rejects when payload bytes don't decode to JSON", () => {
    const encodedSig = base64Url(
      createHmac("sha256", SECRET).update("not-json").digest(),
    );
    const sr = `${encodedSig}.${base64Url("not-json")}`;
    expect(parseMetaSignedRequest(sr, SECRET)).toBeNull();
  });

  it("rejects an empty app secret", () => {
    const sr = makeSignedRequest(validPayload);
    expect(parseMetaSignedRequest(sr, "")).toBeNull();
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const sr = makeSignedRequest(validPayload);
    // Replace the encoded payload with a different one — sig won't match.
    const [sig] = sr.split(".");
    const tampered = `${sig}.${base64Url(
      JSON.stringify({ ...validPayload, user_id: "9999" }),
    )}`;
    expect(parseMetaSignedRequest(tampered, SECRET)).toBeNull();
  });

  describe("maxAgeMs replay guard", () => {
    const NOW = 1_750_000_000_000;
    const issuedAt = Math.floor(NOW / 1000) - 60;

    it("accepts a fresh issued_at within the window", () => {
      const sr = makeSignedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "1",
        issued_at: issuedAt,
      });
      const result = parseMetaSignedRequest(sr, SECRET, {
        maxAgeMs: 24 * 60 * 60 * 1000,
        now: NOW,
      });
      expect(result?.user_id).toBe("1");
    });

    it("rejects a stale issued_at", () => {
      const sr = makeSignedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "1",
        issued_at: Math.floor(NOW / 1000) - 48 * 60 * 60,
      });
      expect(
        parseMetaSignedRequest(sr, SECRET, {
          maxAgeMs: 24 * 60 * 60 * 1000,
          now: NOW,
        }),
      ).toBeNull();
    });

    it("rejects an implausibly-future issued_at", () => {
      const sr = makeSignedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "1",
        issued_at: Math.floor(NOW / 1000) + 60 * 60,
      });
      expect(
        parseMetaSignedRequest(sr, SECRET, {
          maxAgeMs: 24 * 60 * 60 * 1000,
          now: NOW,
        }),
      ).toBeNull();
    });

    it("rejects a missing issued_at when maxAgeMs is set", () => {
      const sr = makeSignedRequest({ algorithm: "HMAC-SHA256", user_id: "1" });
      expect(
        parseMetaSignedRequest(sr, SECRET, {
          maxAgeMs: 24 * 60 * 60 * 1000,
          now: NOW,
        }),
      ).toBeNull();
    });

    it("ignores a stale issued_at when no maxAgeMs is passed", () => {
      const sr = makeSignedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "1",
        issued_at: 1,
      });
      expect(parseMetaSignedRequest(sr, SECRET)?.user_id).toBe("1");
    });

    it("rejects a positive expires in the past but allows expires:0", () => {
      const expired = makeSignedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "1",
        expires: Math.floor(NOW / 1000) - 10,
      });
      expect(parseMetaSignedRequest(expired, SECRET, { now: NOW })).toBeNull();

      const nonExpiring = makeSignedRequest({
        algorithm: "HMAC-SHA256",
        user_id: "1",
        expires: 0,
      });
      expect(
        parseMetaSignedRequest(nonExpiring, SECRET, { now: NOW })?.user_id,
      ).toBe("1");
    });
  });
});
