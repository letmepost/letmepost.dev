import { describe, expect, it } from "vitest";
import { mapMetaError } from "../src/platforms/meta/client.js";

function res(body: unknown, status: number) {
  return { body, status, raw: null };
}

describe("mapMetaError transient reclassification", () => {
  it("maps HTTP 429 to platform_unavailable (retryable)", () => {
    const err = mapMetaError(res({ error: { message: "rate limited" } }, 429));
    expect(err.code).toBe("platform_unavailable");
    expect(err.status).toBe(503);
  });

  it.each([4, 17, 32, 613])(
    "maps rate-limit error code %i to platform_unavailable",
    (code) => {
      const err = mapMetaError(res({ error: { code, message: "quota" } }, 400));
      expect(err.code).toBe("platform_unavailable");
      expect(err.status).toBe(503);
    },
  );

  it("maps 5xx responses to platform_unavailable", () => {
    const err = mapMetaError(res({ error: { message: "server error" } }, 503));
    expect(err.code).toBe("platform_unavailable");
  });

  it.each([1, 2])(
    "maps Meta 'unknown error, please retry' code %i to platform_unavailable",
    (code) => {
      const err = mapMetaError(res({ error: { code, message: "unknown" } }, 400));
      expect(err.code).toBe("platform_unavailable");
    },
  );
});

describe("mapMetaError keeps permanent failures classified as before", () => {
  it("keeps invalid/expired token (code 190) as platform_auth_failed", () => {
    const err = mapMetaError(
      res({ error: { code: 190, message: "expired" } }, 401),
    );
    expect(err.code).toBe("platform_auth_failed");
  });

  it("keeps invalid parameter (code 100) as platform_rejected (permanent)", () => {
    const err = mapMetaError(
      res({ error: { code: 100, message: "bad param" } }, 400),
    );
    expect(err.code).toBe("platform_rejected");
  });

  it("keeps IG media-unreachable (subcode 2207052) as platform_rejected", () => {
    const err = mapMetaError(
      res(
        { error: { code: 100, error_subcode: 2207052, message: "not reachable" } },
        400,
      ),
    );
    expect(err.code).toBe("platform_rejected");
    expect(err.rule).toBe("instagram.media.reachable");
  });
});
