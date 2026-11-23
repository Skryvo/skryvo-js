import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Skryvo } from "../client.js";
import type * as S from "../generated/schemas.js";
import { SkryvoError } from "../errors.js";
import { verifyWebhook } from "../webhooks.js";
import { WEBHOOK_EVENTS } from "../generated/operations.js";

export class UsageError extends Error {}

export interface Option {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  /** Shown in --help; a value placeholder like <id> comes first. */
  help: string;
  required?: boolean;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Context {
  client: () => Skryvo;
  values: Values;
  args: string[];
  data: Record<string, unknown>;
  progress: (line: string) => void;
}

export interface Command {
  summary: string;
  args?: string[];
  options?: Record<string, Option>;
  /** Accepts --data with the request's JSON body; flags win over it. */
  data?: boolean;
  /** Runs without a key or the network. */
  offline?: boolean;
  run: (ctx: Context) => Promise<unknown>;
}

const str = (v: Values, key: string) => (typeof v[key] === "string" ? (v[key] as string) : undefined);
const list = (v: Values, key: string) => (Array.isArray(v[key]) ? (v[key] as string[]) : undefined);

function num(v: Values, key: string): number | undefined {
  const raw = str(v, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} takes a number, not "${raw}".`);
  return n;
}

function yesNo(v: Values, on: string, off: string): boolean | undefined {
  if (v[on] && v[off]) throw new UsageError(`Choose --${on} or --${off}, not both.`);
  return v[on] ? true : v[off] ? false : undefined;
}

function pairs(entries: string[] | undefined, flag: string): Record<string, string> | undefined {
  if (!entries) return undefined;
  return Object.fromEntries(
    entries.map((entry) => {
      const at = entry.indexOf("=");
      if (at < 1) throw new UsageError(`--${flag} takes key=value, not "${entry}".`);
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

function parsed(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** The request body: --data first, then every flag that was given. */
function body<T>(ctx: Context, fields: { [K in keyof T]?: T[K] }): T {
  const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return { ...ctx.data, ...given } as T;
}

async function words(ctx: Context, flag: string, fileFlag: string): Promise<string | undefined> {
  const file = str(ctx.values, fileFlag);
  if (file) return (await readFile(file, "utf8")).trim();
  return str(ctx.values, flag);
}

function arg(ctx: Context, index: number, name: string): string {
  const value = ctx.args[index];
  if (!value) throw new UsageError(`Give the ${name}.`);
  return value;
}

const brand: Option = { type: "string", help: "<id> The brand (default: the account's default brand)" };
const tone: Option = { type: "string", help: "<words> Tone, e.g. friendly" };
const language: Option = { type: "string", help: "<code> Writing language, e.g. en, de" };
const audience: Option = { type: "string", help: "<words> Who it is for" };
const at: Option = {
  type: "string",
  help: "<ISO 8601> When, with the person's offset; moves to the next quarter hour",
};
const later: Record<string, Option> = {
  "callback-url": {
    type: "string",
    help: "<https url> Answer at once with a job; Skryvo posts the answer there, signed, when it is ready",
  },
  wait: { type: "boolean", help: "With --callback-url, also check the job until it ends and print the answer" },
};

/** The call's answer: as it came, or, with --wait, the finished job's answer; a failed job is an error. */
async function finished(ctx: Context, started: unknown): Promise<unknown> {
  const job = started as { job_id?: string };
  if (!ctx.values.wait || !job.job_id) return started;
  ctx.progress(`job ${job.job_id} running`);
  const ended = await ctx.client().jobs.wait(job.job_id, {
    onProgress: (j) => j.status === "running" && ctx.progress("still running"),
  });
  if (ended.status === "failed") {
    throw new SkryvoError(`${ended.error?.detail ?? "The job failed."}`, { status: ended.error?.status });
  }
  return ended.answer;
}

const confirmed: Option = {
  type: "boolean",
  help: "The person approved the summary a first call returned (status: confirm)",
};

export const GROUPS: Record<string, { summary: string; commands: Record<string, Command> }> = {
  account: {
    summary: "The signed-in account, this month's balance and the brand's defaults",
    commands: {
      me: { summary: "Who the key belongs to and the plan", run: ({ client }) => client().account.me() },
      balance: {
        summary: "Generations, image credits and article plans left this month",
        run: ({ client }) => client().account.balance(),
      },
      defaults: {
        summary: "Keep settings as the brand's defaults (only after the person says yes)",
        options: {
          kind: { type: "string", required: true, help: "<post|article>" },
          set: { type: "string", multiple: true, required: true, help: "<setting=value> e.g. tone=friendly" },
          brand,
        },
        run: (ctx) => {
          const settings = Object.fromEntries(
            Object.entries(pairs(list(ctx.values, "set"), "set") ?? {}).map(([k, v]) => [k, parsed(v)]),
          );
          return ctx.client().account.saveDefaults({
            kind: str(ctx.values, "kind") as "post" | "article",
            settings,
            brand_id: str(ctx.values, "brand"),
          });
        },
      },
    },
  },
  brands: {
    summary: "Brands, their design and their look",
    commands: {
      list: { summary: "Every brand the key can use", run: ({ client }) => client().brands.list() },
      add: {
        summary: "Add a brand read from its website (one voice training; ask first)",
        options: {
          name: { type: "string", required: true, help: "<name>" },
          website: { type: "string", required: true, help: "<url>" },
        },
        run: ({ client, values }) =>
          client().brands.add({ name: str(values, "name")!, website: str(values, "website")! }),
      },
      design: {
        summary: "The brand's logo, colours, fonts and kept look",
        options: { brand },
        run: ({ client, values }) => client().brands.design(str(values, "brand")),
      },
      look: {
        summary: "Design the look, steer it, or keep it (keep only on the person's word)",
        args: ["<design|closer|bolder|calmer|photo|keep>"],
        options: { brand },
        run: (ctx) =>
          ctx.client().brands.changeLook({
            change: arg(ctx, 0, "change") as "design",
            brand_id: str(ctx.values, "brand"),
          }),
      },
    },
  },
  channels: {
    summary: "Connected channels and every platform Skryvo offers",
    commands: {
      list: {
        summary: "Connected channels with what each takes (`can`)",
        options: { brand: { type: "string", help: "<id> Only channels that serve this brand" } },
        run: async ({ client, values }) => {
          const all = await client().channels.list();
          const only = str(values, "brand");
          return only ? all.filter((c) => !c.brand_ids?.length || c.brand_ids.includes(only)) : all;
        },
      },
      platforms: {
        summary: "Every platform Skryvo can post to, connected or not",
        run: ({ client }) => client().channels.platforms(),
      },
    },
  },
  posts: {
    summary: "Draft, schedule, change, review, list and cancel posts",
    commands: {
      write: {
        summary: "Draft posts in the brand's voice; schedules nothing",
        data: true,
        options: {
          topic: { type: "string", required: true, help: "<words> What the post is about (up to 200 characters)" },
          platform: { type: "string", multiple: true, help: "<name> e.g. linkedin; up to 4 (default: the brand's)" },
          brand,
          tone,
          language,
          audience,
          cta: { type: "string", help: "<words> Call to action" },
          hashtag: { type: "string", multiple: true, help: "<tag>" },
          link: { type: "string", help: "<url>" },
          pictures: { type: "boolean", help: "A picture in the brand's look with each post" },
          "no-pictures": { type: "boolean", help: "No pictures" },
          confirmed,
          ...later,
        },
        run: async (ctx) =>
          finished(
            ctx,
            await ctx.client().posts.write(
              body<S.WritePostRequest>(ctx, {
                topic: str(ctx.values, "topic"),
                platforms: list(ctx.values, "platform"),
                brand_id: str(ctx.values, "brand"),
                tone: str(ctx.values, "tone"),
                language: str(ctx.values, "language"),
                audience: str(ctx.values, "audience"),
                call_to_action: str(ctx.values, "cta"),
                hashtags: list(ctx.values, "hashtag"),
                link: str(ctx.values, "link"),
                pictures: yesNo(ctx.values, "pictures", "no-pictures"),
                confirmed: ctx.values.confirmed ? true : undefined,
                callback_url: str(ctx.values, "callback-url"),
              }),
            ),
          ),
      },
      schedule: {
        summary: "Schedule approved words to channels (only after the person's go-ahead)",
        data: true,
        options: {
          text: { type: "string", help: "<words> The exact approved text" },
          "text-file": { type: "string", help: "<path> Read the text from a file" },
          channel: { type: "string", multiple: true, required: true, help: "<id> A channel id from `channels list`" },
          at,
          image: { type: "string", help: "<url> One picture for every channel" },
          "image-for": { type: "string", multiple: true, help: "<channel=url> A channel's own picture" },
          link: { type: "string", help: "<url> The page the post points to" },
          button: { type: "string", help: "<learn_more|book|order|shop|sign_up|call> Business Profile button" },
          brand,
          "tiktok-privacy": {
            type: "string",
            help: "<SELF_ONLY|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|PUBLIC_TO_EVERYONE> chosen by the person",
          },
        },
        run: async (ctx) => {
          const privacy = str(ctx.values, "tiktok-privacy");
          const text = (await words(ctx, "text", "text-file")) ?? (ctx.data.text as string | undefined);
          if (!text) throw new UsageError("Give the approved text with --text or --text-file.");
          return ctx.client().posts.schedule(
            body<S.SchedulePostRequest>(ctx, {
              text,
              channel_ids: list(ctx.values, "channel"),
              at: str(ctx.values, "at"),
              image_url: str(ctx.values, "image"),
              images: pairs(list(ctx.values, "image-for"), "image-for"),
              link: str(ctx.values, "link"),
              button: str(ctx.values, "button"),
              brand_id: str(ctx.values, "brand"),
              tiktok: privacy ? ({ privacy } as S.TikTokPostSettings) : undefined,
            }),
          );
        },
      },
      list: {
        summary: "Scheduled and recent posts with their status",
        options: { days: { type: "string", help: "<n> Days ahead to include (default 30, up to 90)" } },
        run: ({ client, values }) => client().posts.list({ days: num(values, "days") }),
      },
      change: {
        summary: "Move a post not yet out, change its words, or both",
        args: ["<post-id>"],
        options: { at, text: { type: "string", help: "<words>" }, "text-file": { type: "string", help: "<path>" } },
        run: async (ctx) =>
          ctx.client().posts.change(arg(ctx, 0, "post id"), {
            at: str(ctx.values, "at"),
            text: await words(ctx, "text", "text-file"),
          }),
      },
      review: {
        summary: "Approve or send back a team post waiting for a reviewer",
        args: ["<post-id>"],
        options: {
          approve: { type: "boolean", help: "Approve it" },
          reject: { type: "boolean", help: "Send it back" },
          note: { type: "string", help: "<words> What should change" },
        },
        run: (ctx) => {
          const approve = yesNo(ctx.values, "approve", "reject");
          if (approve === undefined) throw new UsageError("Choose --approve or --reject.");
          return ctx.client().posts.review(arg(ctx, 0, "post id"), { approve, note: str(ctx.values, "note") });
        },
      },
      cancel: {
        summary: "Cancel a post before it goes out",
        args: ["<post-id>"],
        run: async (ctx) => {
          const id = arg(ctx, 0, "post id");
          await ctx.client().posts.cancel(id);
          return { cancelled: id };
        },
      },
    },
  },
  pictures: {
    summary: "Pictures in the brand's kept look",
    commands: {
      design: {
        summary: "Design one picture for a post, sized per platform (spends image credits)",
        options: {
          text: { type: "string", required: true, help: "<words> The post's text" },
          platform: { type: "string", multiple: true, required: true, help: "<name>" },
          brand,
          direction: { type: "string", help: "<words> closer, bolder, calmer, or the person's own words" },
          headline: { type: "string", help: "<words> Up to nine words on the picture" },
          photo: { type: "string", help: "<id> One of the brand's own photos (see `brands design`)" },
          ...later,
        },
        run: async (ctx) => {
          const values = ctx.values;
          return finished(
            ctx,
            await ctx.client().pictures.design({
              text: str(values, "text")!,
              platforms: list(values, "platform")!,
              brand_id: str(values, "brand"),
              direction: str(values, "direction"),
              headline: str(values, "headline"),
              photo_id: str(values, "photo"),
              callback_url: str(values, "callback-url"),
            }),
          );
        },
      },
    },
  },
  articles: {
    summary: "Plan, write, check, improve, import, repurpose and publish articles",
    commands: {
      plan: {
        summary: "Plan an article for free: headline, outline and questions for the person",
        data: true,
        options: {
          topic: { type: "string", required: true, help: "<words>" },
          brand,
          length: { type: "string", help: "<words> 100 to 4000" },
          tone,
          style: { type: "string", help: "<how-to|listicle|comparison|case study|explainer|…>" },
          language,
          audience,
          pov: { type: "string", help: "<first|second|third> Point of view" },
          keyword: { type: "string", multiple: true, help: "<phrase>" },
          "must-cover": { type: "string", multiple: true, help: "<point>" },
          "only-you": { type: "string", help: "<words> Facts only the person knows" },
          notes: { type: "string", help: "<words>" },
          source: { type: "string", multiple: true, help: "<url> Up to 3 pages to read" },
          ...later,
        },
        run: async (ctx) =>
          finished(
            ctx,
            await ctx.client().articles.plan(
              body<S.PlanArticleRequest>(ctx, {
                topic: str(ctx.values, "topic"),
                brand_id: str(ctx.values, "brand"),
                length: num(ctx.values, "length"),
                tone: str(ctx.values, "tone"),
                style: str(ctx.values, "style"),
                language: str(ctx.values, "language"),
                audience: str(ctx.values, "audience"),
                point_of_view: str(ctx.values, "pov"),
                keywords: list(ctx.values, "keyword"),
                must_cover: list(ctx.values, "must-cover"),
                only_you: str(ctx.values, "only-you"),
                notes: str(ctx.values, "notes"),
                sources: list(ctx.values, "source"),
                callback_url: str(ctx.values, "callback-url"),
              }),
            ),
          ),
      },
      write: {
        summary: "Write a planned article in the background (2 generations)",
        args: ["<plan-id>"],
        data: true,
        options: {
          question: { type: "string", multiple: true, help: "<words> A plan question, paired in order with --answer" },
          answer: { type: "string", multiple: true, help: "<words> The person's answer" },
          headline: { type: "string", help: "<words>" },
          notes: { type: "string", help: "<words>" },
          pictures: { type: "boolean", help: "A cover picture" },
          "no-pictures": { type: "boolean", help: "No pictures" },
          "inside-pictures": { type: "string", help: "<0-3>" },
          tone,
          audience,
          pov: { type: "string", help: "<first|second|third>" },
          wait: { type: "boolean", help: "Wait until it is written and print the article" },
        },
        run: async (ctx) => {
          const questions = list(ctx.values, "question") ?? [];
          const answers = list(ctx.values, "answer") ?? [];
          if (questions.length !== answers.length) {
            throw new UsageError("Give one --answer for each --question, in the same order.");
          }
          const client = ctx.client();
          const started = await client.articles.write(
            body<S.WriteArticleRequest>(ctx, {
              plan_id: arg(ctx, 0, "plan id"),
              answers: questions.length
                ? questions.map((question, i) => ({ question, answer: answers[i] }))
                : undefined,
              headline: str(ctx.values, "headline"),
              notes: str(ctx.values, "notes"),
              pictures: yesNo(ctx.values, "pictures", "no-pictures"),
              inside_pictures: num(ctx.values, "inside-pictures"),
              tone: str(ctx.values, "tone"),
              audience: str(ctx.values, "audience"),
              point_of_view: str(ctx.values, "pov"),
            }),
          );
          if (!ctx.values.wait || started.status !== "writing") return started;
          return client.articles.waitUntilDone(arg(ctx, 0, "plan id"), {
            onProgress: (s) => s.status === "writing" && ctx.progress("still writing"),
          });
        },
      },
      status: {
        summary: "Where an article is: writing, done with its text and checked claims, or failed",
        args: ["<article-id>"],
        options: { wait: { type: "boolean", help: "Wait until it is done or failed" } },
        run: (ctx) => {
          const id = arg(ctx, 0, "article id");
          const articles = ctx.client().articles;
          return ctx.values.wait
            ? articles.waitUntilDone(id, {
                onProgress: (s) => s.status === "writing" && ctx.progress("still writing"),
              })
            : articles.status(id);
        },
      },
      publish: {
        summary: "Schedule a finished article to a blog, or send it as a draft (after the person approves)",
        args: ["<article-id>"],
        options: {
          channel: { type: "string", required: true, help: "<id> A blog channel" },
          at,
          draft: { type: "boolean", help: "Send it to the blog now as a draft" },
          "original-url": { type: "string", help: "<url> The article's first home, credited by every copy" },
        },
        run: (ctx) =>
          ctx.client().articles.publish(arg(ctx, 0, "article id"), {
            channel_id: str(ctx.values, "channel")!,
            at: str(ctx.values, "at"),
            as_draft: ctx.values.draft ? true : undefined,
            original_url: str(ctx.values, "original-url"),
          }),
      },
      seo: {
        summary: "The article's SEO check, free",
        args: ["<article-id>"],
        run: (ctx) => ctx.client().articles.seo(arg(ctx, 0, "article id")),
      },
      improve: {
        summary: "Improve it as a new version (first free, then one generation; ask first)",
        args: ["<article-id>"],
        options: { goal: { type: "string", help: "<seo|geo_citations|accuracy> (default seo)" } },
        run: (ctx) =>
          ctx.client().articles.improve(arg(ctx, 0, "article id"), {
            goal: str(ctx.values, "goal") as "seo" | undefined,
          }),
      },
      import: {
        summary: "Bring in the person's own article from a file or a public address, free",
        options: {
          url: { type: "string", help: "<url> A public article" },
          file: { type: "string", help: "<path> Markdown or HTML" },
          mine: { type: "boolean", required: true, help: "The person says it is theirs to publish" },
          title: { type: "string", help: "<words>" },
          brand,
        },
        run: async ({ client, values }) => {
          const file = str(values, "file");
          return client().articles.import({
            is_mine: true,
            url: str(values, "url"),
            text: file ? await readFile(file, "utf8") : undefined,
            title: str(values, "title"),
            brand_id: str(values, "brand"),
          });
        },
      },
      repurpose: {
        summary: "Turn a finished article into one post per platform (one generation)",
        args: ["<article-id>"],
        options: { platform: { type: "string", multiple: true, required: true, help: "<name>" } },
        run: (ctx) =>
          ctx.client().articles.repurpose(arg(ctx, 0, "article id"), { platforms: list(ctx.values, "platform")! }),
      },
    },
  },
  emails: {
    summary: "Marketing emails in the brand's voice; nothing is sent",
    commands: {
      write: {
        summary: "Write an email: subject lines, preheader, body, call to action",
        data: true,
        options: {
          about: { type: "string", required: true, help: "<words>" },
          brand,
          type: {
            type: "string",
            help: "<welcome|promotional|newsletter|follow_up|re_engagement|transactional|announcement>",
          },
          tone,
          language,
          audience,
          cta: { type: "string", help: "<words>" },
          length: { type: "string", help: "<words> 100 to 1000" },
          confirmed,
        },
        run: (ctx) =>
          ctx.client().emails.write(
            body<S.WriteEmailRequest>(ctx, {
              about: str(ctx.values, "about"),
              brand_id: str(ctx.values, "brand"),
              email_type: str(ctx.values, "type"),
              tone: str(ctx.values, "tone"),
              language: str(ctx.values, "language"),
              audience: str(ctx.values, "audience"),
              call_to_action: str(ctx.values, "cta"),
              length: num(ctx.values, "length"),
              confirmed: ctx.values.confirmed ? true : undefined,
            }),
          ),
      },
    },
  },
  listings: {
    summary: "Product listings for a marketplace",
    commands: {
      write: {
        summary: "Write a listing from one to ten features",
        data: true,
        options: {
          product: { type: "string", required: true, help: "<name>" },
          feature: { type: "string", multiple: true, required: true, help: "<words>" },
          brand,
          marketplace: { type: "string", help: "<amazon|shopify|etsy|ebay|walmart|tiktok_shop|google_shopping|…>" },
          tone,
          audience,
          language,
          overview: { type: "string", help: "<words>" },
          price: { type: "string", help: "<number>" },
          keywords: { type: "string", help: "<words>" },
          confirmed,
        },
        run: (ctx) =>
          ctx.client().listings.write(
            body<S.WriteListingRequest>(ctx, {
              product: str(ctx.values, "product"),
              features: list(ctx.values, "feature"),
              brand_id: str(ctx.values, "brand"),
              marketplace: str(ctx.values, "marketplace"),
              tone: str(ctx.values, "tone"),
              audience: str(ctx.values, "audience"),
              language: str(ctx.values, "language"),
              overview: str(ctx.values, "overview"),
              price: num(ctx.values, "price"),
              keywords: str(ctx.values, "keywords"),
              confirmed: ctx.values.confirmed ? true : undefined,
            }),
          ),
      },
    },
  },
  ads: {
    summary: "Ad copy per ad platform; nothing runs",
    commands: {
      write: {
        summary: "Write ad variations (one generation)",
        data: true,
        options: {
          product: { type: "string", required: true, help: "<name>" },
          platform: { type: "string", multiple: true, required: true, help: "<name> e.g. google_ads" },
          "what-it-is": { type: "string", help: "<words>" },
          benefit: { type: "string", multiple: true, help: "<words> Up to 5" },
          goal: { type: "string", help: "<goal> (default conversion)" },
          link: { type: "string", help: "<url>" },
          brand,
          language,
          variations: { type: "string", help: "<1-6> (default 3)" },
        },
        run: (ctx) =>
          ctx.client().ads.write(
            body<S.WriteAdRequest>(ctx, {
              product: str(ctx.values, "product"),
              platforms: list(ctx.values, "platform"),
              what_it_is: str(ctx.values, "what-it-is"),
              benefits: list(ctx.values, "benefit"),
              goal: str(ctx.values, "goal"),
              link: str(ctx.values, "link"),
              brand_id: str(ctx.values, "brand"),
              language: str(ctx.values, "language"),
              variations: num(ctx.values, "variations"),
            }),
          ),
      },
    },
  },
  calendar: {
    summary: "Plan a week or a month of topics",
    commands: {
      plan: {
        summary: "Plan topics (one generation); adds nothing until accepted",
        options: {
          start: { type: "string", required: true, help: "<YYYY-MM-DD>" },
          period: { type: "string", help: "<week|month> (default week)" },
          topic: { type: "string", multiple: true, help: "<words>" },
          platform: { type: "string", multiple: true, help: "<name>" },
          brand,
        },
        run: ({ client, values }) =>
          client().calendar.plan({
            start_date: str(values, "start")!,
            period: str(values, "period") as "week" | undefined,
            topics: list(values, "topic"),
            platforms: list(values, "platform"),
            brand_id: str(values, "brand"),
          }),
      },
      accept: {
        summary: "Add the rows the person keeps as planned topics, none set to publish",
        options: { file: { type: "string", required: true, help: "<path> JSON: the kept rows, or {items: [...]}" } },
        run: async ({ client, values }) => {
          const kept = JSON.parse(await readFile(str(values, "file")!, "utf8"));
          return client().calendar.accept({ items: Array.isArray(kept) ? kept : kept.items });
        },
      },
    },
  },
  content: {
    summary: "Earlier work",
    commands: {
      find: {
        summary: "Earlier articles, posts, emails, listings and ads, newest first",
        options: {
          kind: { type: "string", help: "<article|post|email|listing|ad>" },
          limit: { type: "string", help: "<n> Up to 50 (default 20)" },
        },
        run: ({ client, values }) =>
          client().content.find({ kind: str(values, "kind") as "article" | undefined, limit: num(values, "limit") }),
      },
    },
  },
  videos: {
    summary: "The person's own videos",
    commands: {
      list: { summary: "Videos ready to post", run: ({ client }) => client().videos.list() },
      upload: {
        summary: "Upload a video file and make it ready",
        args: ["<file>"],
        options: { mime: { type: "string", help: "<type> e.g. video/mp4" } },
        run: async (ctx) => {
          const file = arg(ctx, 0, "video file");
          ctx.progress(`uploading ${basename(file)}`);
          return ctx.client().videos.upload(new Uint8Array(await readFile(file)), {
            name: basename(file),
            mime: str(ctx.values, "mime"),
          });
        },
      },
    },
  },
  results: {
    summary: "How published work did",
    commands: {
      posts: {
        summary: "Reach, engagement, best times and top posts",
        options: { days: { type: "string", help: "<7|30|90> (default 30)" }, brand },
        run: ({ client, values }) =>
          client().results.get({ days: num(values, "days") as 30 | undefined, brand_id: str(values, "brand") }),
      },
      article: {
        summary: "Every place an article went out, with its readings",
        args: ["<article-id>"],
        run: (ctx) => ctx.client().articles.results(arg(ctx, 0, "article id")),
      },
    },
  },
  jobs: {
    summary: "Long calls made with --callback-url",
    commands: {
      get: {
        summary: "A job: running, done with the call's answer, or failed with why",
        args: ["<job-id>"],
        run: (ctx) => ctx.client().jobs.get(arg(ctx, 0, "job id")),
      },
      wait: {
        summary: "Check a job until it ends and print the call's answer; a failed job exits 1",
        args: ["<job-id>"],
        run: (ctx) => finished({ ...ctx, values: { ...ctx.values, wait: true } }, { job_id: arg(ctx, 0, "job id") }),
      },
    },
  },
  webhooks: {
    summary: "Endpoints Skryvo calls when posts publish or fail and articles are ready",
    commands: {
      list: { summary: "Subscribed endpoints", run: ({ client }) => client().webhooks.list() },
      create: {
        summary: "Subscribe an HTTPS endpoint; the secret is shown only once",
        options: {
          url: { type: "string", required: true, help: "<url>" },
          event: { type: "string", multiple: true, required: true, help: `<${WEBHOOK_EVENTS.join("|")}>` },
        },
        run: ({ client, values }) =>
          client().webhooks.create({
            url: str(values, "url")!,
            events: list(values, "event") as S.NewWebhookRequest["events"],
          }),
      },
      delete: {
        summary: "Unsubscribe an endpoint",
        args: ["<webhook-id>"],
        run: async (ctx) => {
          const id = arg(ctx, 0, "webhook id");
          await ctx.client().webhooks.delete(id);
          return { deleted: id };
        },
      },
      test: {
        summary: 'Send a sample of each subscribed event, marked "test": true',
        args: ["<webhook-id>"],
        run: (ctx) => ctx.client().webhooks.test(arg(ctx, 0, "webhook id")),
      },
      deliveries: {
        summary: "Recent deliveries to an endpoint",
        args: ["<webhook-id>"],
        run: (ctx) => ctx.client().webhooks.deliveries(arg(ctx, 0, "webhook id")),
      },
      verify: {
        summary: "Check a delivery's signature offline and print its event",
        offline: true,
        options: {
          "body-file": { type: "string", required: true, help: "<path> The raw body, exactly as received" },
          signature: { type: "string", required: true, help: "<header> The Skryvo-Signature header" },
          secret: { type: "string", help: "<whsec_…> (default: SKRYVO_WEBHOOK_SECRET)" },
          tolerance: { type: "string", help: "<seconds> Oldest signature accepted (default 300)" },
        },
        run: async ({ values }) => {
          const secret = str(values, "secret") ?? process.env.SKRYVO_WEBHOOK_SECRET ?? "";
          return verifyWebhook(await readFile(str(values, "body-file")!), str(values, "signature"), secret, {
            toleranceSeconds: num(values, "tolerance"),
          });
        },
      },
    },
  },
};
