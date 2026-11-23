# skryvo

The Skryvo SDK for Node.js and the `skryvo` command line: write posts, articles, emails, ads and listings in a
brand's voice, design their pictures, and schedule them to the person's channels once they approve.

[Skryvo](https://skryvo.ai) is a hosted AI content platform. This package is a typed client for its agent API
(`https://api.skryvo.ai/api/v1/agent`), a command-line tool built on it, and a helper that verifies webhook
signatures. It has no runtime dependencies.

- Node.js 18.17 or later for the SDK, 20 or later for the CLI. ESM and CommonJS.
- Docs: https://skryvo.ai/docs/
- MIT licensed. Skryvo itself is a paid service with a 7-day free trial on Hobby and Pro: https://skryvo.ai/pricing/

## Install

```bash
npm install skryvo          # the SDK in a project
npm install --global skryvo # the skryvo command
```

## Sign in

Every call needs an API key `sk_skryvo_…`. Create one in Skryvo under
[Settings › API & agents](https://app.skryvo.ai/settings/agents); it is shown once.

- **SDK:** pass `apiKey`, or set `SKRYVO_API_KEY`.
- **CLI:** run `skryvo login` and paste the key at the hidden prompt (or pipe it in:
  `skryvo login < key.txt`). The CLI checks the key, then saves it to `~/.config/skryvo/api-key`
  (`$XDG_CONFIG_HOME/skryvo/api-key` when set; `%APPDATA%\skryvo\api-key` on Windows), readable only by you.
  `SKRYVO_API_KEY` wins over the saved key. `skryvo logout` deletes the file.

A key acts in the workspace it was made in, with the role its holder has there. An OAuth access token (`sko_…`)
works in place of a key.

## 60 seconds with the SDK

```js
import { Skryvo } from "skryvo";

const skryvo = new Skryvo(); // reads SKRYVO_API_KEY

const [brand] = await skryvo.brands.list();
// { id: "bv_3c9d0e", name: "Northside Coffee", is_default: true }

const channels = await skryvo.channels.list();
const linkedin = channels.find((c) => c.platform === "linkedin" && !c.needs_reconnect);
// { id: "conn_8f2e1a", platform: "linkedin", kind: "social", can: { words: 3000, poll: true, … } }

const drafts = await skryvo.posts.write({
  topic: "Our new studio opens Saturday",
  brand_id: brand.id,
  platforms: ["linkedin"],
  pictures: false,
});
// { status: "written", generation_id: "gen_5d1c9a",
//   posts: [{ platform: "linkedin", text: "Our new studio opens this Saturday in Leeds. #coffee", hashtags: ["coffee"] }],
//   settings: [{ field: "tone", value: "friendly", from: "brand" }, …] }

// Show the draft to the person. Only after their go-ahead:
const [post] = await skryvo.posts.schedule({
  text: drafts.posts[0].text,
  channel_ids: [linkedin.id],
  at: "2026-11-24T09:00:00+00:00",
});
// { id: "c1a2b3c4d5", platform: "linkedin", channel_id: "conn_8f2e1a", date: "2026-11-24", time: "09:00",
//   status: "scheduled", auto_publish: true, open_in_skryvo: "https://app.skryvo.ai/calendar?date=2026-11-24", … }
```

**Drafting and scheduling are separate on purpose.** `posts.write` drafts and schedules nothing. When the call
leaves a choice to the brand's defaults (platforms or pictures), Skryvo writes nothing and answers
`status: "confirm"` with each setting, where it came from, the cost and what is left this month: show it, then
call again with the person's final values and `confirmed: true`. `posts.schedule` publishes the words you send,
so send only words the person approved. Any scheduled post can be cancelled before it goes out.

## 60 seconds with the CLI

```bash
$ skryvo login
Paste your Skryvo API key (create one at https://app.skryvo.ai/settings/agents):
{ "signed_in": "sam@example.com", "plan": "pro", "saved_to": "/home/sam/.config/skryvo/api-key" }

$ skryvo channels list --readable
id: conn_8f2e1a
platform: linkedin
name: Northside Coffee
…

$ skryvo posts write --topic "Our new studio opens Saturday" --platform linkedin --no-pictures
$ skryvo posts schedule --text-file approved.txt --channel conn_8f2e1a --at 2026-11-24T09:00:00+00:00
$ skryvo posts list --days 7 -r
```

Output is JSON on stdout, so it pipes into `jq`; `-r` / `--readable` prints one field per line. Errors go to
stderr (JSON, or one line with `-r`), and the exit code is `0` on success, `1` when Skryvo refused or could not
be reached, `2` for a usage mistake. Every command has `--help`. Commands that send a body also take
`--data '<json>'` or `--data @body.json` for fields without a flag (for example `by_channel`); flags win.

## Every operation

| SDK | CLI | Route |
|---|---|---|
| `account.me()` | `account me` | `GET /me` |
| `account.balance()` | `account balance` | `GET /balance` |
| `account.saveDefaults(body)` | `account defaults --kind --set k=v` | `POST /defaults` |
| `brands.list()` | `brands list` | `GET /brands` |
| `brands.add(body)` | `brands add --name --website` | `POST /brands` |
| `brands.design(brandId?)` | `brands design` | `GET /design` |
| `brands.changeLook(body)` | `brands look <change>` | `POST /design/look` |
| `channels.list()` | `channels list [--brand]` | `GET /channels` |
| `channels.platforms()` | `channels platforms` | `GET /platforms` |
| `posts.write(body)` | `posts write` | `POST /drafts` |
| `posts.schedule(body)` | `posts schedule` | `POST /posts` |
| `posts.list({ days })` | `posts list` | `GET /posts` |
| `posts.change(id, body)` | `posts change <id>` | `PATCH /posts/{id}` |
| `posts.review(id, body)` | `posts review <id> --approve\|--reject` | `POST /posts/{id}/review` |
| `posts.cancel(id)` | `posts cancel <id>` | `DELETE /posts/{id}` |
| `pictures.design(body)` | `pictures design` | `POST /pictures` |
| `articles.plan(body)` | `articles plan` | `POST /articles/plan` |
| `articles.write(body)` | `articles write <plan-id> [--wait]` | `POST /articles` |
| `articles.status(id)`, `articles.waitUntilDone(id)` | `articles status <id> [--wait]` | `GET /articles/{id}` |
| `articles.publish(id, body)` | `articles publish <id> --channel` | `POST /articles/{id}/publish` |
| `articles.seo(id)` | `articles seo <id>` | `GET /articles/{id}/seo` |
| `articles.improve(id, body)` | `articles improve <id>` | `POST /articles/{id}/improve` |
| `articles.results(id)` | `results article <id>` | `GET /articles/{id}/results` |
| `articles.import(body)` | `articles import --url\|--file --mine` | `POST /articles/import` |
| `articles.repurpose(id, body)` | `articles repurpose <id> --platform` | `POST /articles/{id}/posts` |
| `emails.write(body)` | `emails write` | `POST /emails` |
| `listings.write(body)` | `listings write` | `POST /listings` |
| `ads.write(body)` | `ads write` | `POST /ads` |
| `calendar.plan(body)` | `calendar plan --start` | `POST /calendar/plan` |
| `calendar.accept(body)` | `calendar accept --file` | `POST /calendar/accept` |
| `content.find({ kind, limit })` | `content find` | `GET /content` |
| `videos.list()` | `videos list` | `GET /videos` |
| `videos.add(body)`, `videos.finish(id)`, `videos.upload(bytes, file)` | `videos upload <file>` | `POST /videos`, upload, `POST /videos/{id}/finish` |
| `results.get({ days, brand_id })` | `results posts` | `GET /results` |
| `webhooks.list()` | `webhooks list` | `GET /webhooks` |
| `webhooks.create(body)` | `webhooks create --url --event` | `POST /webhooks` |
| `webhooks.delete(id)` | `webhooks delete <id>` | `DELETE /webhooks/{id}` |
| `webhooks.test(id)` | `webhooks test <id>` | `POST /webhooks/{id}/test` |
| `webhooks.deliveries(id)` | `webhooks deliveries <id>` | `GET /webhooks/{id}/deliveries` |
| `verifyWebhook(body, header, secret)` | `webhooks verify` | offline |

Request and response types are exported by name (`WritePostRequest`, `WritePostResponse`, `Post`,
`ChannelRules`, …), and `skryvo.request(method, path, { query, body })` reaches any agent route directly.

Articles take a few minutes: `articles.plan` is free and returns the outline and the questions only the person
can answer; `articles.write` starts the writing in the background; `articles.waitUntilDone(id)` polls every 30
seconds and returns the article with each checked claim, its verdict and its sources.

## Webhooks

Subscribe an HTTPS endpoint to `post.published`, `post.failed`, `article.ready`, `article.failed` or
`results.ready`. The answer carries the endpoint's `secret` (`whsec_…`) once; keep it. Each delivery is a POST
with a `Skryvo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` header. Verify it against
the raw body, before parsing it:

```js
import express from "express";
import { verifyWebhook } from "skryvo";

const app = express();
app.post("/skryvo", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.get("Skryvo-Signature"), process.env.SKRYVO_WEBHOOK_SECRET);
    if (event.type === "post.published") console.log("live:", event.data);
    res.sendStatus(204);
  } catch {
    res.sendStatus(400);
  }
});
```

`verifyWebhook` refuses a signature older than five minutes (`toleranceSeconds` changes it), compares in
constant time, and accepts any of several `v1=` values.

## Errors

Every failure is a `SkryvoError` with `status`, `message`, `fields`, `retryAfter` and `requestId`:

| Class | When |
|---|---|
| `RefusedError` (422) | Skryvo refused, and `message` says why in a sentence to show the person, e.g. "That time has passed. Pick a time in the future." A field check failure lists each field in `fields`. |
| `AuthenticationError` (401) | The key is missing, revoked or mistyped. |
| `PermissionDeniedError` (403) | The key's team role can't do this. |
| `NotFoundError` (404) | No such route or item. |
| `RateLimitError` (429) | Over 60 requests a minute or 1000 an hour for this key; `retryAfter` says how long to wait. |
| `ServerError` (5xx) | Skryvo or its AI provider is unavailable. |
| `ConnectionError` | No answer: network down, or the timeout (180 seconds by default) passed. |

The client retries a rate limit after `Retry-After` (twice by default, `maxRetries` changes it). It retries a
dropped connection or a 502, 503 or 504 only on reads, so a call that spends generations is never sent twice.

```js
new Skryvo({ apiKey, baseUrl, timeoutMs: 180_000, maxRetries: 2, fetch, userAgent });
```

## Contributing

```bash
npm install
npm test          # builds, then runs the SDK and CLI tests offline against the spec's own examples
npm run typecheck
```

`spec/openapi.json` is Skryvo's published description of the agent API (`https://api.skryvo.ai/openapi.json`,
also written by Skryvo's `export_agent_openapi.py`). `npm run generate` rewrites `src/generated/` from it: one
type per schema and per answer, and the table of operations. To take a new version of the API, replace
`spec/openapi.json`, run `npm run generate` and `npm test`; the tests fail when the spec has a route no method
calls. The webhook routes are typed in `src/types.ts` until the spec describes them.

Report bugs at https://github.com/Skryvo/skryvo-js/issues. Questions: support@skryvo.ai.

## License

MIT © Flutter Studio LLC
