import { describe, expect, it } from "vitest";
import { LetmepostError } from "../src/errors.js";
import { isBlockedAddress } from "../src/net/guarded-fetch.js";
import { loadMediaItem } from "../src/platforms/_shared/media.js";

describe("isBlockedAddress", () => {
  const blocked = [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "::ffff:10.0.0.1",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "199.16.156.6",
    "2606:4700::1111",
  ];

  it.each(blocked)("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(allowed)("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("loadMediaItem — URL SSRF guard", () => {
  it("rejects a private-IP URL as validation_failed (hermetic — resolves to itself)", async () => {
    let caught: unknown;
    try {
      await loadMediaItem({ kind: "image", url: "http://10.0.0.1/x.jpg" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LetmepostError);
    const lp = caught as LetmepostError;
    expect(lp.code).toBe("validation_failed");
    expect(lp.status).toBe(400);
    expect(lp.rule).toBe("media.url.disallowed");
  });

  it("rejects a non-http scheme as validation_failed", async () => {
    let caught: unknown;
    try {
      await loadMediaItem({ kind: "image", url: "ftp://example.com/x.jpg" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LetmepostError);
    const lp = caught as LetmepostError;
    expect(lp.code).toBe("validation_failed");
    expect(lp.rule).toBe("media.url.disallowed");
  });
});
