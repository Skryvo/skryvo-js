# Changelog

## 0.1.1

- Published from GitHub Actions through npm trusted publishing, with signed provenance; no npm token is stored.

## 0.1.0

- First release: a typed client for every route of the Skryvo agent API, generated from its OpenAPI
  description, with ESM and CommonJS builds and no runtime dependencies.
- The `skryvo` command line: `login` and `logout`, and commands for accounts, brands, channels, posts,
  pictures, articles, emails, listings, ads, the calendar, earlier work, videos, results and webhooks. JSON by
  default, `--readable` for text, `--help` everywhere.
- `verifyWebhook` checks a delivery's `Skryvo-Signature` header.
- Long calls (`posts.write`, `pictures.design`, `articles.plan`) take `callback_url` and answer with a job;
  `jobs.get`, `jobs.wait` (backing off from 2 to 30 seconds) and `verifyJobCallback`; the CLI's `--callback-url`,
  `--wait` and `jobs` commands.
- Retries a rate limit after `Retry-After`, and a dropped connection or a 502 to 504 on reads only.
