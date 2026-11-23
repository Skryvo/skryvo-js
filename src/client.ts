import { ConnectionError, SkryvoError, errorFromResponse } from "./errors.js";
import type * as S from "./generated/schemas.js";
import { VERSION } from "./version.js";

export type ContentKind = "article" | "post" | "email" | "listing" | "ad";

export const DEFAULT_BASE_URL = "https://api.skryvo.ai/api/v1/agent";

export interface SkryvoOptions {
  /** A key `sk_skryvo_…` from Settings › API & agents, or a sign-in token. Defaults to `SKRYVO_API_KEY`. */
  apiKey?: string;
  baseUrl?: string;
  /** Per request; writing with pictures or planning an article takes about a minute. */
  timeoutMs?: number;
  /** Retries after a rate limit, and after a dropped connection or 502–504 on a read. */
  maxRetries?: number;
  fetch?: typeof fetch;
  userAgent?: string;
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface Call {
  query?: Query;
  body?: unknown;
}

const READS = new Set(["GET", "DELETE"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function envKey(): string | undefined {
  return typeof process !== "undefined" ? process.env?.SKRYVO_API_KEY : undefined;
}

export class Skryvo {
  readonly baseUrl: string;
  readonly account: Account;
  readonly brands: Brands;
  readonly channels: Channels;
  readonly posts: Posts;
  readonly pictures: Pictures;
  readonly articles: Articles;
  readonly emails: Emails;
  readonly listings: Listings;
  readonly ads: Ads;
  readonly calendar: Calendar;
  readonly content: Content;
  readonly videos: Videos;
  readonly results: Results;
  readonly webhooks: Webhooks;
  readonly jobs: Jobs;

  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;

  constructor(options: SkryvoOptions = {}) {
    const apiKey = (options.apiKey ?? envKey() ?? "").trim();
    if (!apiKey) {
      throw new SkryvoError(
        "No Skryvo API key. Create one at https://app.skryvo.ai/settings/agents and pass it as apiKey or set SKRYVO_API_KEY.",
      );
    }
    this.#apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? `skryvo-js/${VERSION}`;
    this.account = new Account(this);
    this.brands = new Brands(this);
    this.channels = new Channels(this);
    this.posts = new Posts(this);
    this.pictures = new Pictures(this);
    this.articles = new Articles(this);
    this.emails = new Emails(this);
    this.listings = new Listings(this);
    this.ads = new Ads(this);
    this.calendar = new Calendar(this);
    this.content = new Content(this);
    this.videos = new Videos(this);
    this.results = new Results(this);
    this.webhooks = new Webhooks(this);
    this.jobs = new Jobs(this);
  }

  /** Any agent route, for one this version doesn't name yet: `request("GET", "/me")`. */
  async request<R>(method: string, path: string, call: Call = {}): Promise<R> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      "user-agent": this.#userAgent,
    };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    const init = { method, headers, body: call.body === undefined ? undefined : JSON.stringify(call.body) };

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (cause) {
        const timedOut = (cause as Error)?.name === "TimeoutError";
        if (!timedOut && READS.has(method) && attempt < this.#maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ConnectionError(
          timedOut
            ? `Skryvo didn't answer within ${Math.round(this.#timeoutMs / 1000)} seconds.`
            : `Couldn't reach Skryvo at ${this.baseUrl}.`,
          { cause },
        );
      }
      if (response.ok) {
        if (response.status === 204) return undefined as R;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as R;
      }
      const body = await response.json().catch(() => undefined);
      const error = errorFromResponse(response.status, body, response.headers);
      const retryable = response.status === 429 || (READS.has(method) && [502, 503, 504].includes(response.status));
      if (!retryable || attempt >= this.#maxRetries) throw error;
      await sleep(Math.min((error.retryAfter ?? 2 ** attempt) * 1000, 60_000));
    }
  }

  /** A plain PUT to an upload address Skryvo handed out; it carries no key. */
  async upload(url: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method: "PUT",
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new ConnectionError("The video upload lost its connection. Start it again.", { cause });
    }
  }
}

abstract class Group {
  constructor(protected readonly client: Skryvo) {}
  protected read<R>(path: string, query?: Query) {
    return this.client.request<R>("GET", path, { query });
  }
  protected send<R>(path: string, body: unknown = {}) {
    return this.client.request<R>("POST", path, { body });
  }
}

const seg = (id: string) => encodeURIComponent(id);

/** A long call's body with `callback_url`: it answers 202 with a job. */
type Later<T> = T & { callback_url: string };
/** A long call's body without `callback_url`: it waits for the answer. */
type Now<T> = T & { callback_url?: null };

export class Account extends Group {
  me() {
    return this.read<S.MeResponse>("/me");
  }
  balance() {
    return this.read<S.BalanceResponse>("/balance");
  }
  /** Keeps the person's choices as the brand's defaults; only after they say yes. */
  saveDefaults(body: S.SaveDefaultsRequest) {
    return this.send<S.SaveDefaultsResponse>("/defaults", body);
  }
}

export class Brands extends Group {
  async list() {
    return (await this.read<S.BrandsResponse>("/brands")).brands;
  }
  /** Reads a new brand from its website in the background; uses one voice training. */
  add(body: S.AddBrandRequest) {
    return this.send<S.AddBrandResponse>("/brands", body);
  }
  design(brandId?: string) {
    return this.read<S.DesignResponse>("/design", { brand_id: brandId });
  }
  changeLook(body: S.LookChangeRequest) {
    return this.send<S.ChangeLookResponse>("/design/look", body);
  }
}

export class Channels extends Group {
  async list() {
    return (await this.read<S.ChannelsResponse>("/channels")).channels;
  }
  /** Every channel Skryvo offers, connected or not. */
  async platforms() {
    return (await this.read<S.PlatformsResponse>("/platforms")).platforms;
  }
}

export class Posts extends Group {
  /**
   * Drafts posts in the brand's voice and schedules nothing. A guessed setting returns `status: "confirm"`.
   * With `callback_url` it answers at once with a job; see `jobs.wait`.
   */
  write(body: Later<S.WritePostRequest>): Promise<S.JobAccepted>;
  write(body: Now<S.WritePostRequest>): Promise<S.PostsToConfirm | S.PostsWritten>;
  write(body: S.WritePostRequest): Promise<S.WritePostResponse>;
  write(body: S.WritePostRequest) {
    return this.send<S.WritePostResponse>("/drafts", body);
  }
  /** Schedules approved words to channels; call it only after the person's go-ahead. */
  async schedule(body: S.SchedulePostRequest) {
    return (await this.send<S.SchedulePostResponse>("/posts", body)).posts;
  }
  async list(query: { days?: number } = {}) {
    return (await this.read<S.ScheduledPostsResponse>("/posts", query)).posts;
  }
  change(postId: string, body: S.ChangePostRequest) {
    return this.client.request<S.ChangePostResponse>("PATCH", `/posts/${seg(postId)}`, { body });
  }
  review(postId: string, body: S.ReviewPostRequest) {
    return this.send<S.ReviewPostResponse>(`/posts/${seg(postId)}/review`, body);
  }
  async cancel(postId: string): Promise<void> {
    await this.client.request("DELETE", `/posts/${seg(postId)}`);
  }
}

export class Pictures extends Group {
  /** One picture in the brand's kept look, sized for each platform; spends image credits. */
  design(body: Later<S.PictureRequest>): Promise<S.JobAccepted>;
  design(body: Now<S.PictureRequest>): Promise<S.Pictures>;
  design(body: S.PictureRequest): Promise<S.DesignPictureResponse>;
  design(body: S.PictureRequest) {
    return this.send<S.DesignPictureResponse>("/pictures", body);
  }
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (status: S.ArticleStatusResponse) => void;
}

export class Articles extends Group {
  /** Free: headline, outline, search phrase and the questions only the person can answer. */
  plan(body: Later<S.PlanArticleRequest>): Promise<S.JobAccepted>;
  plan(body: Now<S.PlanArticleRequest>): Promise<S.ArticlePlan>;
  plan(body: S.PlanArticleRequest): Promise<S.PlanArticleResponse>;
  plan(body: S.PlanArticleRequest) {
    return this.send<S.PlanArticleResponse>("/articles/plan", body);
  }
  /** Starts writing a plan in the background; follow it with `status` or `waitUntilDone`. */
  write(body: S.WriteArticleRequest) {
    return this.send<S.WriteArticleResponse>("/articles", body);
  }
  status(articleId: string) {
    return this.read<S.ArticleStatusResponse>(`/articles/${seg(articleId)}`);
  }
  /** Polls `status` until the article is done or failed. */
  async waitUntilDone(articleId: string, options: WaitOptions = {}): Promise<S.ArticleStatusResponse> {
    const interval = options.intervalMs ?? 30_000;
    const deadline = Date.now() + (options.timeoutMs ?? 25 * 60_000);
    for (;;) {
      const status = await this.status(articleId);
      options.onProgress?.(status);
      if (status.status !== "writing") return status;
      if (Date.now() + interval > deadline) {
        throw new SkryvoError(`The article ${articleId} is still being written. Check its status later.`);
      }
      await sleep(interval);
    }
  }
  /** Schedules a finished article to a blog channel, or with `as_draft` sends it there now as a draft. */
  publish(articleId: string, body: S.PublishArticleRequest) {
    return this.send<S.PublishArticleResponse>(`/articles/${seg(articleId)}/publish`, body);
  }
  seo(articleId: string) {
    return this.read<S.ArticleSeoResponse>(`/articles/${seg(articleId)}/seo`);
  }
  improve(articleId: string, body: S.ImproveArticleRequest = {}) {
    return this.send<S.ImproveArticleResponse>(`/articles/${seg(articleId)}/improve`, body);
  }
  results(articleId: string) {
    return this.read<S.ArticleResultsResponse>(`/articles/${seg(articleId)}/results`);
  }
  /** Brings in the person's own article, free, once they say it is theirs (`is_mine: true`). */
  import(body: S.ImportArticleRequest) {
    return this.send<S.ImportArticleResponse>("/articles/import", body);
  }
  /** One post per platform from a finished article, ready for `posts.schedule`. */
  repurpose(articleId: string, body: S.RepurposeArticleRequest) {
    return this.send<S.RepurposeArticleResponse>(`/articles/${seg(articleId)}/posts`, body);
  }
}

export class Emails extends Group {
  write(body: S.WriteEmailRequest) {
    return this.send<S.WriteEmailResponse>("/emails", body);
  }
}

export class Listings extends Group {
  write(body: S.WriteListingRequest) {
    return this.send<S.WriteListingResponse>("/listings", body);
  }
}

export class Ads extends Group {
  write(body: S.WriteAdRequest) {
    return this.send<S.WriteAdResponse>("/ads", body);
  }
}

export class Calendar extends Group {
  /** A week or a month of topics; adds nothing until `accept`. */
  plan(body: S.PlanCalendarRequest) {
    return this.send<S.PlanCalendarResponse>("/calendar/plan", body);
  }
  /** Adds the rows the person keeps as planned topics, none set to publish. */
  accept(body: S.AcceptPlanRequest) {
    return this.send<S.AcceptPlanResponse>("/calendar/accept", body);
  }
}

export class Content extends Group {
  async find(query: { kind?: ContentKind; limit?: number } = {}) {
    return (await this.read<S.FindContentResponse>("/content", query)).items;
  }
}

export class Videos extends Group {
  async list() {
    return (await this.read<S.VideosResponse>("/videos")).videos;
  }
  /** Opens an upload for the person's own video; send the bytes to `upload_url`, then `finish`. */
  add(body: S.AddVideoRequest) {
    return this.send<S.AddVideoResponse>("/videos", body);
  }
  finish(videoId: string) {
    return this.send<S.FinishVideoResponse>(`/videos/${seg(videoId)}/finish`);
  }
  /** add, send every chunk, finish: the video is then ready for `by_channel.<id>.video_id`. */
  async upload(data: Uint8Array, file: { name: string; mime?: string }): Promise<S.FinishVideoResponse> {
    const opened = await this.add({ name: file.name, size: data.byteLength, mime: file.mime ?? "" });
    const chunk = opened.chunk_bytes;
    for (let start = 0; start < data.byteLength; start += chunk) {
      const end = Math.min(start + chunk, data.byteLength);
      const sent = await this.client.upload(opened.upload_url, data.slice(start, end), {
        "content-range": `bytes ${start}-${end - 1}/${data.byteLength}`,
      });
      const done = end === data.byteLength;
      if (done ? !sent.ok : sent.status !== 308) {
        throw new SkryvoError(`The video upload stopped at byte ${start} (${sent.status}). Start it again.`, {
          status: sent.status,
        });
      }
    }
    return this.finish(opened.id);
  }
}

export class Results extends Group {
  /** Reach, engagement, best times and top posts over 7, 30 or 90 days. */
  get(query: { days?: 7 | 30 | 90; brand_id?: string } = {}) {
    return this.read<S.ResultsResponse>("/results", query);
  }
}

export class Webhooks extends Group {
  async list() {
    return (await this.read<S.Webhooks>("/webhooks")).webhooks;
  }
  /** The reply's `secret` is shown only now; keep it to verify each delivery. */
  create(body: S.NewWebhookRequest) {
    return this.send<S.WebhookCreated>("/webhooks", body);
  }
  async delete(webhookId: string): Promise<void> {
    await this.client.request("DELETE", `/webhooks/${seg(webhookId)}`);
  }
  /** Sends a sample of each subscribed event, marked `"test": true`. */
  async test(webhookId: string) {
    return (await this.send<S.Deliveries>(`/webhooks/${seg(webhookId)}/test`)).deliveries;
  }
  /** The last 30 days' deliveries, newest first, up to 50. */
  async deliveries(webhookId: string) {
    return (await this.read<S.Deliveries>(`/webhooks/${seg(webhookId)}/deliveries`)).deliveries;
  }
}

export interface JobWaitOptions {
  /** First wait between checks; it doubles up to `maxIntervalMs`. */
  intervalMs?: number;
  maxIntervalMs?: number;
  timeoutMs?: number;
  onProgress?: (job: S.Job) => void;
}

export class Jobs extends Group {
  /** A long call's job: running, or done with the call's own answer, or failed with why. */
  get(jobId: string) {
    return this.read<S.Job>(`/jobs/${seg(jobId)}`);
  }
  /** Checks the job, 2 s apart and doubling to 30 s, until it is done or failed. */
  async wait(jobId: string, options: JobWaitOptions = {}): Promise<S.Job> {
    let interval = options.intervalMs ?? 2_000;
    const most = options.maxIntervalMs ?? 30_000;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const job = await this.get(jobId);
      options.onProgress?.(job);
      if (job.status !== "running") return job;
      if (Date.now() + interval > deadline) {
        throw new SkryvoError(`The job ${jobId} is still running. Check it later with jobs.get.`);
      }
      await sleep(interval);
      interval = Math.min(interval * 2, most);
    }
  }
}
