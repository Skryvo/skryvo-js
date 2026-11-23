import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Skryvo,
  OPERATIONS,
  AuthenticationError,
  ConnectionError,
  RateLimitError,
  RefusedError,
  ServerError,
  WebhookVerificationError,
  sign,
  verifyWebhook,
} from "../dist/index.js";
import { exampleFor, fakeFetch, fromSpec } from "./helpers.mjs";

const KEY = "sk_skryvo_test";
const BASE = "https://api.skryvo.ai/api/v1/agent";

function client(handler, options = {}) {
  const fake = fakeFetch(handler);
  return { skryvo: new Skryvo({ apiKey: KEY, fetch: fake.fetch, ...options }), calls: fake.calls };
}

test("every operation in the spec has a method", async () => {
  const { skryvo, calls } = client((call) => exampleFor(call.method, call.path) ?? { body: {} });
  const id = "x1";
  await skryvo.account.me();
  await skryvo.account.balance();
  await skryvo.account.saveDefaults({ kind: "post", settings: { tone: "friendly" } });
  await skryvo.brands.list();
  await skryvo.brands.add({ name: "Northside", website: "https://example.com" });
  await skryvo.brands.design("bv_1");
  await skryvo.brands.changeLook({ change: "closer" });
  await skryvo.channels.list();
  await skryvo.channels.platforms();
  await skryvo.posts.write({ topic: "Our studio opens Saturday" });
  await skryvo.posts.schedule({ text: "Hello", channel_ids: ["c1"] });
  await skryvo.posts.list({ days: 7 });
  await skryvo.posts.change(id, { text: "New words" });
  await skryvo.posts.review(id, { approve: true });
  await skryvo.posts.cancel(id);
  await skryvo.pictures.design({ text: "Hello", platforms: ["linkedin"] });
  await skryvo.articles.plan({ topic: "Grinders" });
  await skryvo.articles.write({ plan_id: "pl_1" });
  await skryvo.articles.status(id);
  await skryvo.articles.publish(id, { channel_id: "c1" });
  await skryvo.articles.seo(id);
  await skryvo.articles.improve(id);
  await skryvo.articles.results(id);
  await skryvo.articles.import({ is_mine: true, url: "https://example.com/post" });
  await skryvo.articles.repurpose(id, { platforms: ["linkedin"] });
  await skryvo.emails.write({ about: "Spring menu" });
  await skryvo.listings.write({ product: "Board", features: ["Oak"] });
  await skryvo.ads.write({ product: "Board", platforms: ["google_ads"] });
  await skryvo.calendar.plan({ start_date: "2026-12-01" });
  await skryvo.calendar.accept({ items: [{ date: "2026-12-01", time: "09:00", content_type: "social_media", topic: "t" }] });
  await skryvo.content.find({ kind: "article" });
  await skryvo.videos.list();
  await skryvo.videos.add({ name: "a.mp4", size: 10 });
  await skryvo.videos.finish(id);
  await skryvo.results.get({ days: 30 });
  await skryvo.webhooks.list();
  await skryvo.webhooks.create({ url: "https://example.com/hook", events: ["post.published"] });
  await skryvo.webhooks.delete(id);
  await skryvo.webhooks.test(id);
  await skryvo.webhooks.deliveries(id);

  const called = new Set(calls.map((c) => `${c.method} ${c.path.slice("/api/v1/agent".length).replace(/x1|pl_1/g, "{}")}`));
  const wanted = OPERATIONS.map((op) => `${op.method} ${op.path.replace(/\{[^}]+\}/g, "{}")}`);
  for (const route of wanted) assert.ok(called.has(route), `no method calls ${route}`);
  assert.equal(called.size, new Set(wanted).size);
});

test("sends the key, JSON and query, and unwraps lists", async () => {
  const { skryvo, calls } = client(fromSpec);
  const channels = await skryvo.channels.list();
  assert.equal(channels[0].platform, "linkedin");
  await skryvo.posts.list({ days: 7 });
  await skryvo.brands.design(undefined);
  await skryvo.posts.schedule({ text: "Hi", channel_ids: ["c1"], at: "2026-12-01T09:00:00+01:00" });
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.match(calls[0].headers["user-agent"], /^skryvo-js\//);
  assert.equal(calls[1].url.search, "?days=7");
  assert.equal(calls[2].url.search, "");
  assert.deepEqual(calls[3].body, { text: "Hi", channel_ids: ["c1"], at: "2026-12-01T09:00:00+01:00" });
  assert.equal(calls[3].headers["content-type"], "application/json");
  assert.equal(calls[3].url.href, `${BASE}/posts`);
});

test("reads SKRYVO_API_KEY and refuses to start without a key", () => {
  const before = process.env.SKRYVO_API_KEY;
  delete process.env.SKRYVO_API_KEY;
  assert.throws(() => new Skryvo(), /No Skryvo API key/);
  process.env.SKRYVO_API_KEY = KEY;
  assert.ok(new Skryvo());
  if (before === undefined) delete process.env.SKRYVO_API_KEY;
  else process.env.SKRYVO_API_KEY = before;
});

test("a refusal carries Skryvo's own words", async () => {
  const { skryvo } = client(() => ({ status: 422, body: { detail: "That time has passed. Pick a time in the future." } }));
  await assert.rejects(skryvo.posts.schedule({ text: "Hi", channel_ids: ["c1"] }), (error) => {
    assert.ok(error instanceof RefusedError);
    assert.equal(error.status, 422);
    assert.equal(error.message, "That time has passed. Pick a time in the future.");
    return true;
  });
});

test("a validation failure names each field", async () => {
  const body = {
    error: "validation_error",
    message: "Request validation failed",
    details: [{ field: "topic", message: "String should have at least 3 characters", type: "string_too_short" }],
  };
  const { skryvo } = client(() => ({ status: 422, body }));
  await assert.rejects(skryvo.posts.write({ topic: "x" }), (error) => {
    assert.equal(error.fields[0].field, "topic");
    assert.match(error.message, /topic: String should have at least 3 characters/);
    return true;
  });
});

test("401 is an AuthenticationError", async () => {
  const { skryvo } = client(() => ({ status: 401, body: { detail: "Send a live Skryvo API key." } }));
  await assert.rejects(skryvo.account.me(), AuthenticationError);
});

test("a rate limit is retried after Retry-After, on writes too", async () => {
  const { skryvo, calls } = client((_, n) =>
    n === 1
      ? { status: 429, body: { error: "rate_limit_exceeded", message: "Slow down" }, headers: { "retry-after": "0.01" } }
      : { status: 200, body: { status: "written", posts: [] } },
  );
  const out = await skryvo.posts.write({ topic: "Hello there" });
  assert.equal(out.status, "written");
  assert.equal(calls.length, 2);
});

test("a rate limit past the retries is a RateLimitError with retryAfter", async () => {
  const { skryvo } = client(() => ({ status: 429, body: { message: "Slow down" }, headers: { "retry-after": "0.01" } }), {
    maxRetries: 1,
  });
  await assert.rejects(skryvo.account.me(), (error) => error instanceof RateLimitError && error.retryAfter === 0.01);
});

test("a 503 is retried on a read but never on a write that spends", async () => {
  const read = client((_, n) => (n === 1 ? { status: 503, body: { message: "busy" }, headers: { "retry-after": "0.01" } } : fromSpec({ method: "GET", path: "/api/v1/agent/me" })));
  assert.equal((await read.skryvo.account.me()).plan, "pro");
  const write = client(() => ({ status: 503, body: { message: "Our AI service is unavailable right now." } }));
  await assert.rejects(write.skryvo.posts.write({ topic: "Hello there" }), ServerError);
  assert.equal(write.calls.length, 1);
});

test("a dropped connection is a ConnectionError", async () => {
  const { skryvo } = client(() => new TypeError("fetch failed"), { maxRetries: 0 });
  await assert.rejects(skryvo.account.me(), ConnectionError);
});

test("a request past the timeout is a ConnectionError that says so", async () => {
  const slow = (url, init) =>
    new Promise((_, reject) => {
      const held = setTimeout(() => {}, 5000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(held);
        reject(init.signal.reason);
      });
    });
  const skryvo = new Skryvo({ apiKey: KEY, fetch: slow, timeoutMs: 20 });
  await assert.rejects(skryvo.account.me(), /didn't answer within/);
});

test("waitUntilDone polls until the article is done", async () => {
  const done = exampleFor("GET", "/api/v1/agent/articles/pl_1").body;
  const { skryvo, calls } = client((_, n) => ({ body: n < 3 ? { article_id: "pl_1", status: "writing" } : done }));
  const seen = [];
  const out = await skryvo.articles.waitUntilDone("pl_1", { intervalMs: 1, onProgress: (s) => seen.push(s.status) });
  assert.equal(out.status, "done");
  assert.deepEqual(seen, ["writing", "writing", "done"]);
  assert.equal(calls.length, 3);
});

test("videos.upload opens an upload, sends each chunk with its range, then finishes", async () => {
  const data = new Uint8Array(10).fill(7);
  const { skryvo, calls } = client((call) => {
    if (call.path.endsWith("/videos")) return { status: 201, body: { id: "clip_1", upload_url: "https://upload.example/s", chunk_bytes: 4 } };
    if (call.url.host === "upload.example") {
      return { status: call.headers["content-range"].endsWith("9/10") ? 200 : 308 };
    }
    return { body: { video_id: "clip_1", status: "ready", seconds: 12, width: 1080, height: 1920 } };
  });
  const ready = await skryvo.videos.upload(data, { name: "launch.mp4", mime: "video/mp4" });
  assert.equal(ready.status, "ready");
  assert.deepEqual(calls[0].body, { name: "launch.mp4", size: 10, mime: "video/mp4" });
  assert.deepEqual(
    calls.filter((c) => c.method === "PUT").map((c) => c.headers["content-range"]),
    ["bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"],
  );
  assert.ok(calls.filter((c) => c.method === "PUT").every((c) => !c.headers.authorization));
  assert.equal(calls.at(-1).path, "/api/v1/agent/videos/clip_1/finish");
});

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "post.published", created: "2026-11-23T10:00:00Z", data: { id: "p1" } });

test("verifyWebhook accepts a delivery signed with the endpoint's secret", () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${sign(BODY, SECRET, t)}`;
  const event = verifyWebhook(BODY, header, SECRET, { now: t + 10 });
  assert.equal(event.type, "post.published");
  assert.equal(verifyWebhook(new TextEncoder().encode(BODY), header, SECRET, { now: t }).id, "evt_1");
});

test("verifyWebhook accepts any of several v1 signatures", () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${"0".repeat(64)},v1=${sign(BODY, SECRET, t)}`;
  assert.equal(verifyWebhook(BODY, header, SECRET, { now: t }).id, "evt_1");
});

test("verifyWebhook refuses a changed body, a wrong secret, an old signature and a bad header", () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${sign(BODY, SECRET, t)}`;
  assert.throws(() => verifyWebhook(BODY.replace("p1", "p2"), header, SECRET, { now: t }), /doesn't match/);
  assert.throws(() => verifyWebhook(BODY, header, "whsec_other", { now: t }), WebhookVerificationError);
  assert.throws(() => verifyWebhook(BODY, header, SECRET, { now: t + 301 }), /older than 300 seconds/);
  assert.throws(() => verifyWebhook(BODY, "v1=abc", SECRET, { now: t }), /form t=/);
  assert.throws(() => verifyWebhook(BODY, undefined, SECRET), /no Skryvo-Signature/);
});

test("the CommonJS build loads", async () => {
  const { createRequire } = await import("node:module");
  const required = createRequire(import.meta.url)("../dist/index.cjs");
  assert.equal(typeof required.Skryvo, "function");
  assert.equal(typeof required.verifyWebhook, "function");
});
