export { Letmepost } from "./client.js";
export type { ClientConfig, RequestOptions, FetchLike } from "./http.js";

export {
  LetmepostError,
  ValidationError,
  PreflightFailedError,
  PlatformAuthError,
  PlatformRejectedError,
  PlatformUnavailableError,
  PlatformNotEnabledError,
  InternalError,
  UnauthenticatedError,
  UnauthorizedError,
  NotFoundError,
  IdempotencyConflictError,
  RateLimitedError,
} from "./errors.js";
export type { ErrorCode, Platform, ErrorEnvelope } from "./errors.js";

export {
  verifyWebhook,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  EVENT_ID_HEADER,
  DELIVERY_ID_HEADER,
} from "./webhooks.js";
export type { WebhookEvent, WebhookEventType, VerifyWebhookArgs } from "./webhooks.js";

export { newIdempotencyKey } from "./idempotency.js";

export type {
  CreatePostRequest,
  CreatePostResponse,
  PostTarget,
  PostTargetResult,
  PostStatus,
  BatchStatus,
  MediaInput,
  FirstComment,
  TargetOptions,
  Post,
  PostAttempt,
  PostDetail,
  ListPostsParams,
  PostListResponse,
} from "./resources/posts.js";

export type {
  Account,
  AccountListResponse,
  ConnectDescriptorResponse,
  PinterestBoard,
  PinterestBoardsResponse,
  CreatePinterestBoardRequest,
  CreatePinterestBoardResponse,
  SetPinterestDefaultBoardResponse,
} from "./resources/accounts.js";

export type {
  ApiKey,
  ApiKeyListResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  RevokeApiKeyResponse,
} from "./resources/apiKeys.js";

export type {
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  WebhookEndpointListResponse,
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
  TestWebhookDeliveryRequest,
  TestWebhookDeliveryResponse,
} from "./resources/webhooks.js";

export type {
  MediaAsset,
  MediaListResponse,
  ListMediaParams,
} from "./resources/media.js";
