import { readFileSync } from "node:fs";

export const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"));

/** The spec's own example answer for a method and path, or undefined. */
export function exampleFor(method, path) {
  for (const [template, item] of Object.entries(spec.paths)) {
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    const op = item[method.toLowerCase()];
    if (!op || !pattern.test(path)) continue;
    const code = Object.keys(op.responses).find((c) => c.startsWith("2"));
    return { status: Number(code), body: op.responses[code]?.content?.["application/json"]?.example };
  }
  return undefined;
}

/** A fetch that answers from a list of handlers and records every request. */
export function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = {
      method: init.method ?? "GET",
      url: u,
      path: u.pathname,
      headers: init.headers ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const answer = await handler(call, calls.length);
    if (answer instanceof Error) throw answer;
    const { status = 200, body, headers = {} } = answer ?? {};
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fetch, calls };
}

export const fromSpec = (call) => exampleFor(call.method, call.path) ?? { status: 404, body: { detail: "Not Found" } };
