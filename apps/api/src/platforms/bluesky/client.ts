import { platformFetch } from "../_shared/http.js";
import { authFailed, extractUpstreamMessage, rejected, upstreamDetail } from "../_shared/errors.js";

const DEFAULT_PDS = "https://bsky.social";
const PLATFORM = "bluesky";

export interface BlueskySession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

export interface BlueskyPostResult {
  uri: string;
  cid: string;
}

/**
 * AT Proto blob descriptor returned by `com.atproto.repo.uploadBlob` and
 * subsequently embedded inside a record's `embed` field.
 * See: https://atproto.com/specs/data-model#blob-type
 */
export interface BlueskyBlobRef {
  $type: "blob";
  ref: { $link: string } | string;
  mimeType: string;
  size: number;
}

export interface BlueskyUploadBlobResponse {
  blob: BlueskyBlobRef;
}

export interface BlueskyStrongRef {
  uri: string;
  cid: string;
}

export interface BlueskyReplyRef {
  root: BlueskyStrongRef;
  parent: BlueskyStrongRef;
}

/**
 * Discriminated union of record-level `embed` values we support today. The
 * AT Proto lexicon allows richer embeds (external, record, recordWithMedia)
 * but Phase 3.5 scope is images + single video only.
 */
export type BlueskyEmbed =
  | {
      $type: "app.bsky.embed.images";
      images: Array<{ image: BlueskyBlobRef; alt: string }>;
    }
  | {
      $type: "app.bsky.embed.video";
      video: BlueskyBlobRef;
      alt: string;
    };

export interface BlueskyCreatePostInput {
  text: string;
  embed?: BlueskyEmbed;
  reply?: BlueskyReplyRef;
}

export class BlueskyClient {
  constructor(
    private readonly identifier: string,
    private readonly password: string,
    private readonly pdsUrl: string = DEFAULT_PDS,
  ) {}

  async createSession(): Promise<BlueskySession> {
    const res = await platformFetch<BlueskySession>({
      method: "POST",
      url: `${this.pdsUrl}/xrpc/com.atproto.server.createSession`,
      body: { identifier: this.identifier, password: this.password },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        remediation:
          "Verify the identifier (handle or email) and use a Bluesky app password, not the account password. Generate one at https://bsky.app/settings/app-passwords.",
      });
    }
    return res.body;
  }

  /**
   * Rotate an existing session using its `refreshJwt`. Returns new access +
   * refresh JWTs. Throws `platform_auth_failed` if the refresh JWT is
   * revoked or the PDS is unreachable — caller typically falls back to a
   * full `createSession` with stored credentials.
   *
   * See: https://docs.bsky.app/docs/api/com-atproto-server-refresh-session
   */
  static async refreshSession(
    refreshJwt: string,
    pdsUrl: string = DEFAULT_PDS,
  ): Promise<BlueskySession> {
    const res = await platformFetch<BlueskySession>({
      method: "POST",
      url: `${pdsUrl}/xrpc/com.atproto.server.refreshSession`,
      headers: { Authorization: `Bearer ${refreshJwt}` },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body) {
      throw authFailed({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        message: "Bluesky refresh failed — refresh JWT may be revoked or expired.",
        remediation:
          "Re-authenticate with the stored app password to obtain a fresh session.",
      });
    }
    return res.body;
  }

  /**
   * Upload raw bytes to the PDS. The returned `BlobRef` is what you embed in
   * a record's `embed.images[].image` or `embed.video` field.
   */
  async uploadBlob(
    session: BlueskySession,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<BlueskyBlobRef> {
    const res = await platformFetch<BlueskyUploadBlobResponse>({
      method: "POST",
      url: `${this.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`,
      headers: {
        Authorization: `Bearer ${session.accessJwt}`,
        "Content-Type": mimeType,
      },
      body: bytes,
      platform: PLATFORM,
    });
    if (!res.ok || !res.body || !res.body.blob) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        ...(extractUpstreamMessage(res.body) !== undefined
          ? { upstreamMessage: extractUpstreamMessage(res.body)! }
          : {}),
        remediation:
          "Upstream rejected the blob upload. Inspect platformResponse; most commonly the blob exceeds per-file limits or the mime type is unsupported.",
      });
    }
    return res.body.blob;
  }

  /**
   * Create an `app.bsky.feed.post` record. Accepts optional `embed` (images
   * or video) and optional `reply` (to thread a post below another one).
   */
  async createPost(
    session: BlueskySession,
    input: BlueskyCreatePostInput | string,
  ): Promise<BlueskyPostResult> {
    // Keep the legacy string signature so callers that only post text
    // (and any tests pinned to the old shape) keep working.
    const { text, embed, reply } =
      typeof input === "string" ? { text: input, embed: undefined, reply: undefined } : input;

    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
    };
    if (embed) record.embed = embed;
    if (reply) record.reply = reply;

    const res = await platformFetch<BlueskyPostResult>({
      method: "POST",
      url: `${this.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
      headers: { Authorization: `Bearer ${session.accessJwt}` },
      body: {
        repo: session.did,
        collection: "app.bsky.feed.post",
        record,
      },
      platform: PLATFORM,
    });
    if (!res.ok || !res.body) {
      throw rejected({
        platform: PLATFORM,
        platformResponse: upstreamDetail(res),
        ...(extractUpstreamMessage(res.body) !== undefined
          ? { upstreamMessage: extractUpstreamMessage(res.body)! }
          : {}),
      });
    }
    return res.body;
  }
}
