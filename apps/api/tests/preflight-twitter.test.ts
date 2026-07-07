import { describe, expect, it } from "vitest";
import {
  TWITTER_GIF_MAX_BYTES,
  TWITTER_IMAGE_MAX_BYTES,
  TWITTER_MAX_GRAPHEMES,
  TWITTER_TCO_URL_LENGTH,
  TWITTER_VIDEO_MAX_BYTES,
} from "@letmepost/schemas";
import {
  countTwitterWeightedGraphemes,
  validateTwitterMedia,
  validateTwitterText,
  type TwitterResolvedMediaItem,
} from "../src/platforms/twitter/preflight.js";
import { LetmepostError } from "../src/errors.js";

describe("countTwitterWeightedGraphemes", () => {
  it("counts plain ascii by grapheme", () => {
    expect(countTwitterWeightedGraphemes("hello world")).toBe(11);
  });

  it("weighs a compound (ZWJ) emoji as a single weight-2 unit", () => {
    // A family emoji is one grapheme cluster but weighs 2 on X, not 1.
    expect(countTwitterWeightedGraphemes("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("weighs a single emoji as 2", () => {
    expect(countTwitterWeightedGraphemes("😀")).toBe(2);
  });

  it("weighs a CJK code point as 2", () => {
    expect(countTwitterWeightedGraphemes("中")).toBe(2);
  });

  it("keeps Latin text at weight 1 per grapheme", () => {
    expect(countTwitterWeightedGraphemes("café résumé")).toBe(11);
  });

  it("wraps a URL to t.co weight regardless of real length", () => {
    const short = "https://a.co/x";
    const long =
      "https://really-long-subdomain.example.com/path/to/a/very/deeply/nested/resource?query=foo&more=bar";
    expect(countTwitterWeightedGraphemes(short)).toBe(TWITTER_TCO_URL_LENGTH);
    expect(countTwitterWeightedGraphemes(long)).toBe(TWITTER_TCO_URL_LENGTH);
  });

  it("adds t.co weight per URL in a longer text", () => {
    const text = "look: https://a.co and https://b.co";
    // "look: " = 6, 2 URLs wrapped to 23 each, " and " = 5 → 6 + 23 + 5 + 23 = 57
    expect(countTwitterWeightedGraphemes(text)).toBe(57);
  });
});

describe("validateTwitterText", () => {
  it("accepts 280-grapheme text", () => {
    expect(() => validateTwitterText("a".repeat(280))).not.toThrow();
  });

  it("rejects 281-grapheme text with twitter.text.max_graphemes", () => {
    try {
      validateTwitterText("a".repeat(281));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      const e = err as LetmepostError;
      expect(e.code).toBe("preflight_failed");
      expect(e.rule).toBe("twitter.text.max_graphemes");
      expect(e.platform).toBe("twitter");
    }
  });

  it("rejects empty text with twitter.text.non_empty", () => {
    try {
      validateTwitterText("   ");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.text.non_empty");
    }
  });

  it("accepts a tweet that only fits because the URL was shortened", () => {
    // Real length: 280 chars of 'a' + a 100-char URL → 380. Weighted: 280 + 23 = 303. Still over.
    // But with 200 a's + a 200-char URL: weighted = 200 + 23 = 223. Under.
    const tweet = "a".repeat(200) + " " + "https://example.com/" + "b".repeat(180);
    expect(countTwitterWeightedGraphemes(tweet)).toBeLessThan(TWITTER_MAX_GRAPHEMES);
    expect(() => validateTwitterText(tweet)).not.toThrow();
  });

  it("rejects when real-length is fine but weighted length exceeds the limit", () => {
    // 270 a's + ' ' + short URL: real = 270 + 1 + 16 ≈ 287; weighted = 270 + 1 + 23 = 294 → over 280.
    const tweet = "a".repeat(270) + " https://a.co/x";
    expect(() => validateTwitterText(tweet)).toThrow(LetmepostError);
  });

  it("accepts 140 emoji (280 weight — exactly at the limit)", () => {
    // Each emoji weighs 2 on X → 140 × 2 = 280, right at the budget.
    const text = "👨‍👩‍👧‍👦".repeat(140);
    expect(countTwitterWeightedGraphemes(text)).toBe(280);
    expect(() => validateTwitterText(text)).not.toThrow();
  });

  it("rejects 141 emoji (282 weight — over the limit)", () => {
    // 141 × 2 = 282 > 280. Preflight must catch what X would reject.
    const text = "👨‍👩‍👧‍👦".repeat(141);
    expect(countTwitterWeightedGraphemes(text)).toBe(282);
    try {
      validateTwitterText(text);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.text.max_graphemes");
    }
  });

  it("accepts 140 CJK characters (280 weight — exactly at the limit)", () => {
    const text = "中".repeat(140);
    expect(countTwitterWeightedGraphemes(text)).toBe(280);
    expect(() => validateTwitterText(text)).not.toThrow();
  });

  it("rejects 141 CJK characters (282 weight — over the limit)", () => {
    const text = "中".repeat(141);
    expect(countTwitterWeightedGraphemes(text)).toBe(282);
    expect(() => validateTwitterText(text)).toThrow(LetmepostError);
  });

  it("counts Latin (weight-1) text unchanged — 280 accepted", () => {
    const text = "a".repeat(280);
    expect(countTwitterWeightedGraphemes(text)).toBe(280);
    expect(() => validateTwitterText(text)).not.toThrow();
  });
});

function image(
  overrides: Partial<TwitterResolvedMediaItem> = {},
): TwitterResolvedMediaItem {
  return {
    kind: "image",
    mimeType: "image/jpeg",
    byteLength: 10_000,
    ...overrides,
  };
}

function video(
  overrides: Partial<TwitterResolvedMediaItem> = {},
): TwitterResolvedMediaItem {
  return {
    kind: "video",
    mimeType: "video/mp4",
    byteLength: 10_000_000,
    ...overrides,
  };
}

describe("validateTwitterMedia", () => {
  it("accepts empty media", () => {
    expect(() => validateTwitterMedia([])).not.toThrow();
  });

  it("accepts a single image", () => {
    expect(() => validateTwitterMedia([image()])).not.toThrow();
  });

  it("accepts a single video", () => {
    expect(() => validateTwitterMedia([video()])).not.toThrow();
  });

  it("accepts a single gif", () => {
    expect(() =>
      validateTwitterMedia([image({ mimeType: "image/gif" })]),
    ).not.toThrow();
  });

  it("accepts up to 4 images on a single tweet", () => {
    expect(() =>
      validateTwitterMedia([image(), image(), image(), image()]),
    ).not.toThrow();
  });

  it("rejects 5 images with twitter.media.count_max", () => {
    try {
      validateTwitterMedia([image(), image(), image(), image(), image()]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.media.count_max");
    }
  });

  it("rejects mixing image + video on the same tweet", () => {
    try {
      validateTwitterMedia([image(), video()]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe(
        "twitter.media.image_video_exclusive",
      );
    }
  });

  it("rejects alt text > 1000 graphemes", () => {
    try {
      validateTwitterMedia([
        image({ altText: "a".repeat(1001) }),
      ]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe(
        "twitter.media.alt_text_max_graphemes",
      );
    }
  });

  it("rejects disallowed image mime with twitter.media.mime_allowed", () => {
    try {
      validateTwitterMedia([image({ mimeType: "image/heic" })]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.media.mime_allowed");
    }
  });

  it("rejects non-mp4 video with twitter.media.mime_allowed", () => {
    try {
      validateTwitterMedia([video({ mimeType: "video/webm" })]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.media.mime_allowed");
    }
  });

  it("rejects oversized image with twitter.media.image_size_max", () => {
    try {
      validateTwitterMedia([image({ byteLength: TWITTER_IMAGE_MAX_BYTES + 1 })]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.media.image_size_max");
    }
  });

  it("rejects oversized gif with twitter.media.gif_size_max", () => {
    try {
      validateTwitterMedia([
        image({
          mimeType: "image/gif",
          byteLength: TWITTER_GIF_MAX_BYTES + 1,
        }),
      ]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.media.gif_size_max");
    }
  });

  it("rejects oversized video with twitter.media.video_size_max", () => {
    try {
      validateTwitterMedia([video({ byteLength: TWITTER_VIDEO_MAX_BYTES + 1 })]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LetmepostError);
      expect((err as LetmepostError).rule).toBe("twitter.media.video_size_max");
    }
  });
});
