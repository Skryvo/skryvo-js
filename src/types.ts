// Webhook shapes from the webhook contract; the published spec does not describe these routes yet.

export const WEBHOOK_EVENTS = [
  "post.published",
  "post.failed",
  "article.ready",
  "article.failed",
  "results.ready",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface CreateWebhookRequest {
  url: string;
  events: WebhookEventType[];
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventType[];
}

/** Returned once, when the endpoint is created: keep `secret` to verify deliveries. */
export interface NewWebhook extends Webhook {
  secret: string;
}

export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  created: string;
  data: T;
  /** true on a sample sent by `webhooks.test`. */
  test?: boolean;
}

export type ContentKind = "article" | "post" | "email" | "listing" | "ad";
