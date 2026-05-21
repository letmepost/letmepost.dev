import { HttpClient, type ClientConfig } from "./http.js";
import { PostsResource } from "./resources/posts.js";
import { AccountsResource } from "./resources/accounts.js";
import { ApiKeysResource } from "./resources/apiKeys.js";
import { WebhooksResource } from "./resources/webhooks.js";
import { MediaResource } from "./resources/media.js";

/**
 * Main entrypoint:
 *
 *   const lmp = new Letmepost({ apiKey: process.env.LMP_API_KEY! });
 *   await lmp.posts.create({ targets: [{ platform: "bluesky" }], text: "hi" });
 */
export class Letmepost {
  readonly posts: PostsResource;
  readonly accounts: AccountsResource;
  readonly apiKeys: ApiKeysResource;
  readonly webhooks: WebhooksResource;
  readonly media: MediaResource;

  /** Exposed for advanced use (extra headers, custom retry on a one-off call). */
  readonly http: HttpClient;

  constructor(config: ClientConfig) {
    this.http = new HttpClient(config);
    this.posts = new PostsResource(this.http);
    this.accounts = new AccountsResource(this.http);
    this.apiKeys = new ApiKeysResource(this.http);
    this.webhooks = new WebhooksResource(this.http);
    this.media = new MediaResource(this.http);
  }
}
