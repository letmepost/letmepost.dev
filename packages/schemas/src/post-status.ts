import { z } from "zod";

export const PostStatus = z.enum([
  "queued",
  "validated",
  "publishing",
  "published",
  "failed",
  "rejected",
  "canceled",
]);
export type PostStatus = z.infer<typeof PostStatus>;
