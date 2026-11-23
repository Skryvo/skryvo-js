import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "../dist/index.js";
import { exampleFor } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const KEY = "sk_skryvo_cli_test";
let server;
let base;
let configDir;
const seen = [];

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "skryvo-cli-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      seen.push({ method: req.method, url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: "Send a live Skryvo API key." });
      if (raw.includes('"text":"too late"')) {
        return send(422, { detail: "That time has passed. Pick a time in the future." });
      }
      const example = exampleFor(req.method, url.pathname);
      if (!example) return send(404, { detail: "Not Found" });
      send(example.status, example.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1/agent`;
});

after(() => server.close());

const { SKRYVO_API_KEY, SKRYVO_BASE_URL, SKRYVO_WEBHOOK_SECRET, ...inherited } = process.env;

function cli(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...inherited, SKRYVO_BASE_URL: base, SKRYVO_CONFIG_DIR: configDir, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? "");
  });
}

test("login reads the key from stdin, checks it and saves it readable only by its owner", async () => {
  const { code, out } = await cli(["login"], { input: `${KEY}\n` });
  assert.equal(code, 0);
  const said = JSON.parse(out);
  assert.equal(said.signed_in, "sam@example.com");
  const path = join(configDir, "api-key");
  assert.equal(said.saved_to, path);
  assert.equal((await readFile(path, "utf8")).trim(), KEY);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("login refuses something that is not a key, and a key Skryvo rejects", async () => {
  assert.equal((await cli(["login"], { input: "hello\n" })).code, 2);
  const rejected = await cli(["login"], { input: "sk_skryvo_wrong\n", env: { SKRYVO_CONFIG_DIR: join(configDir, "other") } });
  assert.equal(rejected.code, 1);
  assert.match(JSON.parse(rejected.err).error.message, /live Skryvo API key/);
});

test("prints JSON by default and readable text with -r, using the saved key", async () => {
  await writeFile(join(configDir, "api-key"), `${KEY}\n`, { mode: 0o600 });
  const json = await cli(["brands", "list"]);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.out)[0].id, "bv_3c9d0e");
  const text = await cli(["account", "balance", "-r"]);
  assert.match(text.out, /^plan: pro$/m);
  assert.match(text.out, /^left:\n {2}generations: /m);
});

test("SKRYVO_API_KEY wins over the saved key", async () => {
  const { code } = await cli(["account", "me"], { env: { SKRYVO_API_KEY: "sk_skryvo_other" } });
  assert.equal(code, 1);
});

test("posts schedule sends the approved words, channels, time and per-channel pictures", async () => {
  seen.length = 0;
  const { code, out } = await cli([
    "posts", "schedule",
    "--text", "Doors open at nine.",
    "--channel", "c1", "--channel", "c2",
    "--at", "2026-12-01T09:00:00+01:00",
    "--image-for", "c2=https://example.com/c2.jpg",
    "--data", '{"by_channel":{"c1":{"thread":["Then coffee."]}}}',
  ]);
  assert.equal(code, 0, out);
  assert.deepEqual(seen[0].body, {
    by_channel: { c1: { thread: ["Then coffee."] } },
    text: "Doors open at nine.",
    channel_ids: ["c1", "c2"],
    at: "2026-12-01T09:00:00+01:00",
    images: { c2: "https://example.com/c2.jpg" },
  });
  assert.ok(Array.isArray(JSON.parse(out)));
});

test("posts write maps flags to the API's fields and --no-pictures to false", async () => {
  seen.length = 0;
  await cli(["posts", "write", "--topic", "Studio opens Saturday", "--platform", "linkedin", "--hashtag", "coffee", "--cta", "Visit us", "--no-pictures", "--confirmed"]);
  assert.deepEqual(seen[0].body, {
    topic: "Studio opens Saturday",
    platforms: ["linkedin"],
    call_to_action: "Visit us",
    hashtags: ["coffee"],
    pictures: false,
    confirmed: true,
  });
});

test("query options reach the URL", async () => {
  seen.length = 0;
  await cli(["posts", "list", "--days", "7"]);
  await cli(["content", "find", "--kind", "article", "--limit", "5"]);
  assert.equal(seen[0].url.search, "?days=7");
  assert.equal(seen[1].url.search, "?kind=article&limit=5");
});

test("a refusal prints Skryvo's words on stderr and exits 1", async () => {
  const json = await cli(["posts", "schedule", "--text", "too late", "--channel", "c1"]);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.err).error, {
    type: "RefusedError",
    status: 422,
    message: "That time has passed. Pick a time in the future.",
  });
  const text = await cli(["posts", "schedule", "--text", "too late", "--channel", "c1", "-r"]);
  assert.equal(text.err.trim(), "Error (422): That time has passed. Pick a time in the future.");
});

test("usage mistakes exit 2 with the reason", async () => {
  const missing = await cli(["posts", "schedule", "--channel", "c1"]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--text or --text-file/);
  const unknown = await cli(["posts", "write", "--topic", "x", "--colour", "red"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /--colour/);
  const group = await cli(["nope"]);
  assert.equal(group.code, 2);
});

test("--help works at every level", async () => {
  assert.match((await cli(["--help"])).out, /Usage: skryvo <group> <command>/);
  assert.match((await cli(["articles", "--help"])).out, /publish/);
  const help = await cli(["articles", "write", "--help"]);
  assert.match(help.out, /--question <words>/);
  assert.match(help.out, /\(repeatable\)/);
});

test("webhooks verify checks a delivery offline", async () => {
  const body = JSON.stringify({ id: "evt_1", type: "article.ready", created: "2026-11-23T10:00:00Z", data: {} });
  const file = join(configDir, "delivery.json");
  await writeFile(file, body);
  const t = Math.floor(Date.now() / 1000);
  const secret = "whsec_cli";
  const good = await cli(["webhooks", "verify", "--body-file", file, "--signature", `t=${t},v1=${sign(body, secret, t)}`], {
    env: { SKRYVO_WEBHOOK_SECRET: secret, SKRYVO_CONFIG_DIR: join(configDir, "empty") },
  });
  assert.equal(good.code, 0, good.err);
  assert.equal(JSON.parse(good.out).type, "article.ready");
  const bad = await cli(["webhooks", "verify", "--body-file", file, "--signature", `t=${t},v1=00`, "--secret", secret]);
  assert.equal(bad.code, 1);
});

test("logout forgets the key", async () => {
  const { out } = await cli(["logout"]);
  assert.equal(JSON.parse(out).forgot, join(configDir, "api-key"));
  assert.equal((await cli(["account", "me"])).code, 1);
});
