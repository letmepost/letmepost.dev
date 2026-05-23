import { describe, expect, it } from "vitest";
import {
  TIKTOK_MAX_CAPTION_CHARS,
  TIKTOK_MAX_HASHTAG_COUNT,
  TIKTOK_VIDEO_MAX_BYTES,
  type MediaInput,
} from "@letmepost/schemas";
import {
  countHashtags,
  validateTikTokInput,
  validateTikTokVideoBytes,
  validateTikTokVideoProbe,
} from "../src/platforms/tiktok/preflight.js";
import { LetmepostError } from "../src/errors.js";

const videoItem: MediaInput = {
  kind: "video",
  url: "https://example.com/clip.mp4",
};

function baseInput() {
  return {
    text: "Caption",
    media: [videoItem],
  };
}

describe("countHashtags", () => {
  it("counts ASCII hashtags", () => {
    expect(countHashtags("hello #world #foo")).toBe(2);
  });
  it("counts unicode hashtags", () => {
    expect(countHashtags("#日本語 #cafe")).toBe(2);
  });
  it("ignores `#` followed by whitespace", () => {
    expect(countHashtags("just a # symbol")).toBe(0);
  });
  it("returns 0 on empty input", () => {
    expect(countHashtags("")).toBe(0);
  });
});

describe("validateTikTokInput — shape", () => {
  it("accepts a basic video input", () => {
    expect(() => validateTikTokInput(baseInput())).not.toThrow();
  });

  it("rejects caption beyond 2200 chars with tiktok.text.max_chars", () => {
    try {
      validateTikTokInput({
        ...baseInput(),
        text: "a".repeat(TIKTOK_MAX_CAPTION_CHARS + 1),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.text.max_chars");
    }
  });

  it("rejects > 100 hashtags with tiktok.text.hashtag_max", () => {
    const text = Array.from(
      { length: TIKTOK_MAX_HASHTAG_COUNT + 1 },
      (_, i) => `#h${i}`,
    ).join(" ");
    try {
      validateTikTokInput({ ...baseInput(), text });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.text.hashtag_max");
    }
  });

  it("rejects missing media with tiktok.media.required", () => {
    try {
      validateTikTokInput({ ...baseInput(), media: [] });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.media.required");
    }
  });

  it("rejects multi-media with tiktok.media.single_only", () => {
    try {
      validateTikTokInput({
        ...baseInput(),
        media: [videoItem, videoItem],
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.media.single_only");
    }
  });

  it("rejects non-video media with tiktok.media.video_required", () => {
    try {
      validateTikTokInput({
        ...baseInput(),
        media: [{ kind: "image", url: "https://example.com/img.jpg" }],
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.media.video_required");
    }
  });

  it("rejects both brand toggles with tiktok.branded_content.mutual_exclusive", () => {
    try {
      validateTikTokInput({
        ...baseInput(),
        brandContentToggle: true,
        brandOrganicToggle: true,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe(
        "tiktok.branded_content.mutual_exclusive",
      );
    }
  });
});

describe("validateTikTokInput — audit-state privacy", () => {
  it("forces SELF_ONLY for audit accounts and emits a warning", () => {
    const result = validateTikTokInput({
      ...baseInput(),
      privacy: "public_to_everyone",
      auditState: "audit",
      privacyLevelOptions: ["SELF_ONLY"],
    });
    expect(result.privacy).toBe("SELF_ONLY");
    expect(result.warnings.map((w) => w.code)).toContain(
      "tiktok.audit.self_only",
    );
  });

  it("accepts SELF_ONLY on audit accounts without warning", () => {
    const result = validateTikTokInput({
      ...baseInput(),
      privacy: "self_only",
      auditState: "audit",
      privacyLevelOptions: ["SELF_ONLY"],
    });
    expect(result.privacy).toBe("SELF_ONLY");
    expect(result.warnings).toHaveLength(0);
  });

  it("accepts public_to_everyone on production accounts when the allowlist permits it", () => {
    const result = validateTikTokInput({
      ...baseInput(),
      privacy: "public_to_everyone",
      auditState: "production",
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    });
    expect(result.privacy).toBe("PUBLIC_TO_EVERYONE");
    expect(result.warnings).toHaveLength(0);
  });

  it("rejects unsupported privacy on production accounts with tiktok.privacy.not_allowed", () => {
    try {
      validateTikTokInput({
        ...baseInput(),
        privacy: "public_to_everyone",
        auditState: "production",
        privacyLevelOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"],
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.privacy.not_allowed");
    }
  });

  it("defaults to SELF_ONLY when caller omits privacy", () => {
    const result = validateTikTokInput({
      ...baseInput(),
      auditState: "audit",
      privacyLevelOptions: ["SELF_ONLY"],
    });
    expect(result.privacy).toBe("SELF_ONLY");
  });
});

describe("validateTikTokVideoBytes", () => {
  it("accepts mp4", () => {
    expect(() =>
      validateTikTokVideoBytes({
        mimeType: "video/mp4",
        byteLength: 1_000_000,
      }),
    ).not.toThrow();
  });

  it("rejects unsupported mime with tiktok.file_format.invalid", () => {
    try {
      validateTikTokVideoBytes({
        mimeType: "video/3gpp",
        byteLength: 1_000_000,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.file_format.invalid");
    }
  });

  it("rejects byte size beyond the 4 GB ceiling", () => {
    try {
      validateTikTokVideoBytes({
        mimeType: "video/mp4",
        byteLength: TIKTOK_VIDEO_MAX_BYTES + 1,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.video.size_max");
    }
  });
});

describe("validateTikTokVideoProbe", () => {
  it("rejects videos shorter than 3 seconds with tiktok.video.too_short", () => {
    try {
      validateTikTokVideoProbe({
        probe: { durationSeconds: 2, width: 1080, height: 1920 },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.video.too_short");
    }
  });

  it("rejects videos longer than 10 minutes with tiktok.video.too_long", () => {
    try {
      validateTikTokVideoProbe({
        probe: { durationSeconds: 601, width: 1080, height: 1920 },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("tiktok.video.too_long");
    }
  });

  it("warns audit accounts about > 60s videos", () => {
    const warnings = validateTikTokVideoProbe({
      probe: { durationSeconds: 90, width: 1080, height: 1920 },
      accountAudit: "audit",
    });
    expect(warnings.map((w) => w.code)).toContain(
      "tiktok.video.sandbox_duration",
    );
  });

  it("does NOT warn production accounts about > 60s videos", () => {
    const warnings = validateTikTokVideoProbe({
      probe: { durationSeconds: 90, width: 1080, height: 1920 },
      accountAudit: "production",
    });
    expect(warnings.map((w) => w.code)).not.toContain(
      "tiktok.video.sandbox_duration",
    );
  });

  it("rejects resolution below 540 short-edge with tiktok.resolution.unsupported", () => {
    try {
      validateTikTokVideoProbe({
        probe: { durationSeconds: 10, width: 480, height: 854 },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe(
        "tiktok.resolution.unsupported",
      );
    }
  });

  it("emits a non-vertical aspect warning on 1:1 video", () => {
    const warnings = validateTikTokVideoProbe({
      probe: { durationSeconds: 10, width: 1080, height: 1080 },
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("tiktok.video.aspect_non_vertical");
  });

  it("emits an unusual-aspect warning for ratios off the preferred list", () => {
    const warnings = validateTikTokVideoProbe({
      probe: { durationSeconds: 10, width: 1200, height: 1800 },
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("tiktok.video.aspect_unusual");
  });

  it("emits probe_unavailable warning when ffprobe is missing", () => {
    const warnings = validateTikTokVideoProbe({
      probe: { ffprobeUnavailable: true },
    });
    expect(warnings.map((w) => w.code)).toContain(
      "tiktok.video.probe_unavailable",
    );
  });
});
