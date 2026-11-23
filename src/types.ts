// Webhook shapes from the webhook contract; the published spec does not describe these routes yet.
import type { Post } from "./generated/schemas.js";

export const WEBHOOK_EVENTS = [
  "post.published",
  "post.failed",
  "article.ready",
  "article.failed",
  "results.ready",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface CreateWebhookRequest {
  /** An https address on the public internet. */
  url: string;
  events: WebhookEventType[];
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventType[];
  /** A paused endpoint gets no deliveries until a successful `webhooks.test`. */
  status: "active" | "paused";
  paused_reason: string | null;
  created_at: string;
  last_delivery_at: string | null;
  failures: number;
}

/** Returned once, when the endpoint is created: keep `secret` to verify deliveries. */
export interface NewWebhook extends Webhook {
  secret: string;
}

export interface Delivery {
  id: string;
  event_id: string;
  type: WebhookEventType;
  test: boolean;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string | null;
}

export interface ArticleReady {
  article_id: string;
  generation_id: string;
  title: string;
  words: number;
  score: number | null;
  open_in_skryvo: string;
}

export interface ArticleFailed {
  article_id: string;
  error: string;
  charged: false;
}

export interface ResultsReady {
  /** null for a post made outside the calendar. */
  post_id: string | null;
  publication_id: string;
  platform: string;
  url: string | null;
  milestone: "1h" | "24h" | "7d" | "30d" | "60d" | "90d";
  reach: number | null;
  reach_kind: string | null;
  engagements: number | null;
  clicks: number | null;
  collected_at: string;
}

export interface EventData {
  "post.published": Post;
  "post.failed": Post;
  "article.ready": ArticleReady;
  "article.failed": ArticleFailed;
  "results.ready": ResultsReady;
}

/** One delivery's body. `id` is the event's id, the same on every retry: dedupe on it. */
export type WebhookEvent = {
  [K in WebhookEventType]: { id: string; type: K; created: string; test: boolean; data: EventData[K] };
}[WebhookEventType];

export type ContentKind = "article" | "post" | "email" | "listing" | "ad";
