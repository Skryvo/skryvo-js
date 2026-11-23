import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Skryvo } from "../client.js";
import { AuthenticationError, ConnectionError, SkryvoError } from "../errors.js";
import { VERSION } from "../version.js";
import { GROUPS, UsageError, type Command, type Option, type Values } from "./commands.js";
import { askForKey, forgetKey, keyPath, readKey, saveKey } from "./config.js";
import { readable } from "./readable.js";

const KEYS_PAGE = "https://app.skryvo.ai/settings/agents";

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const GLOBAL: Record<string, Option> = {
  readable: { type: "boolean", short: "r", help: "Readable text instead of JSON" },
  help: { type: "boolean", short: "h", help: "Show help" },
};
const DATA: Option = { type: "string", help: "<json|@file> The request body as JSON; flags override its fields" };

function optionLines(options: Record<string, Option>): string[] {
  return Object.entries(options).map(([name, o]) => {
    const [, placeholder = "", rest = o.help] = o.help.match(/^(<[^>]+>)\s*(.*)$/) ?? [];
    const flag = `${o.short ? `-${o.short}, ` : ""}--${name}${placeholder ? ` ${placeholder}` : ""}`;
    const notes = [rest, o.multiple ? "(repeatable)" : "", o.required ? "(required)" : ""].filter(Boolean);
    const said = notes.join(" ");
    return flag.length < 34 ? `  ${flag.padEnd(34)} ${said}` : `  ${flag}\n  ${"".padEnd(34)} ${said}`;
  });
}

function mainHelp(): string {
  const groups = Object.entries(GROUPS).map(([name, g]) => `  ${name.padEnd(10)} ${g.summary}`);
  return [
    `skryvo ${VERSION}: Skryvo from the command line. Writes in the brand's voice; schedules only what you approve.`,
    "",
    "Usage: skryvo <group> <command> [options]",
    "",
    "Sign in:",
    "  login      Save an API key (from Settings › API & agents) for this user",
    "  logout     Forget the saved key",
    "",
    "Groups:",
    ...groups,
    "",
    "Options:",
    ...optionLines(GLOBAL),
    "  --version                          Print the version",
    "",
    "The key comes from SKRYVO_API_KEY, else from `skryvo login`. Output is JSON unless --readable.",
    "Run `skryvo <group> --help` for its commands. Docs: https://skryvo.ai/docs/",
  ].join("\n");
}

function groupHelp(name: string): string {
  const group = GROUPS[name];
  return [
    `skryvo ${name}: ${group.summary}`,
    "",
    "Commands:",
    ...Object.entries(group.commands).map(([cmd, c]) => `  ${cmd.padEnd(12)} ${c.summary}`),
    "",
    `Run \`skryvo ${name} <command> --help\` for its options.`,
  ].join("\n");
}

function commandHelp(group: string, name: string, command: Command): string {
  const options = { ...(command.options ?? {}), ...(command.data ? { data: DATA } : {}), ...GLOBAL };
  return [
    command.summary,
    "",
    `Usage: skryvo ${group} ${name}${command.args ? ` ${command.args.join(" ")}` : ""} [options]`,
    "",
    "Options:",
    ...optionLines(options),
  ].join("\n");
}

async function data(raw: string | undefined): Promise<Record<string, unknown>> {
  if (!raw) return {};
  const text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new UsageError("--data takes a JSON object, or @path to a file holding one.");
}

async function apiKey(env: NodeJS.ProcessEnv, io: Io): Promise<string> {
  if (env.SKRYVO_API_KEY?.trim()) return env.SKRYVO_API_KEY.trim();
  const path = keyPath(env);
  const saved = await readKey(path);
  if (saved.looseMode) io.err(`warning: ${path} is readable by other users; run chmod 600 on it.`);
  if (saved.key) return saved.key;
  throw new AuthenticationError(
    `No API key. Run \`skryvo login\` or set SKRYVO_API_KEY. Create a key at ${KEYS_PAGE}.`,
  );
}

function clientFor(key: string, env: NodeJS.ProcessEnv): Skryvo {
  return new Skryvo({ apiKey: key, baseUrl: env.SKRYVO_BASE_URL || undefined, userAgent: `skryvo-cli/${VERSION}` });
}

function show(value: unknown, asText: boolean, io: Io): void {
  if (value === undefined) return;
  io.out(asText ? readable(value) : JSON.stringify(value, null, 2));
}

function hint(error: unknown): string | undefined {
  if (error instanceof AuthenticationError && error.status) {
    return `Run \`skryvo login\` with a live key, or set SKRYVO_API_KEY. Keys: ${KEYS_PAGE}`;
  }
  if (error instanceof ConnectionError) return "Check the connection, or SKRYVO_BASE_URL if you set it.";
  return undefined;
}

function report(error: unknown, asText: boolean, io: Io): number {
  if (error instanceof UsageError) {
    io.err(`${error.message}\nRun with --help to see the options.`);
    return 2;
  }
  if (!(error instanceof SkryvoError)) throw error;
  const next = hint(error);
  if (asText) {
    io.err(`Error${error.status ? ` (${error.status})` : ""}: ${error.message}${next ? `\n${next}` : ""}`);
  } else {
    const out = {
      error: {
        type: error.name,
        status: error.status,
        message: error.message,
        ...(error.fields.length ? { fields: error.fields } : {}),
        ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
        ...(next ? { hint: next } : {}),
      },
    };
    io.err(JSON.stringify(out, null, 2));
  }
  return 1;
}

async function login(rest: string[], asText: boolean, io: Io): Promise<number> {
  if (rest.length) throw new UsageError("login reads the key from a hidden prompt or stdin, never from arguments.");
  const path = keyPath(io.env);
  const key = await askForKey(`Paste your Skryvo API key (create one at ${KEYS_PAGE}): `);
  if (!key) throw new UsageError("No key given.");
  if (!key.startsWith("sk_skryvo_")) {
    throw new UsageError("A Skryvo API key starts with sk_skryvo_. Copy it from Settings › API & agents.");
  }
  const me = await clientFor(key, io.env).account.me();
  await saveKey(path, key);
  show({ signed_in: me.email, plan: me.plan, saved_to: path }, asText, io);
  return 0;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [group, name, ...rest] = argv;
  const wantsText = argv.includes("-r") || argv.includes("--readable");
  try {
    if (!group || group === "-h" || group === "--help" || group === "help") {
      io.out(mainHelp());
      return 0;
    }
    if (group === "--version" || group === "-v") {
      io.out(VERSION);
      return 0;
    }
    if (group === "login") {
      if (name === "--help" || name === "-h") {
        io.out("Usage: skryvo login\n\nReads the key from a hidden prompt, or from stdin: `skryvo login < key.txt`.");
        return 0;
      }
      return await login([name, ...rest].filter((a) => a && a !== "-r" && a !== "--readable"), wantsText, io);
    }
    if (group === "logout") {
      const path = keyPath(io.env);
      show({ forgot: (await forgetKey(path)) ? path : null }, wantsText, io);
      return 0;
    }
    const chosen = GROUPS[group];
    if (!chosen) throw new UsageError(`No group "${group}". Groups: ${Object.keys(GROUPS).join(", ")}.`);
    if (!name || name === "--help" || name === "-h") {
      io.out(groupHelp(group));
      return name ? 0 : 2;
    }
    const command = chosen.commands[name];
    if (!command) {
      throw new UsageError(`No command "${group} ${name}". Commands: ${Object.keys(chosen.commands).join(", ")}.`);
    }
    const options = { ...(command.options ?? {}), ...(command.data ? { data: DATA } : {}), ...GLOBAL };
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: Object.fromEntries(
          Object.entries(options).map(([key, o]) => [
            key,
            { type: o.type, multiple: Boolean(o.multiple), ...(o.short ? { short: o.short } : {}) },
          ]),
        ),
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    const { values, positionals } = parsed;
    if (values.help) {
      io.out(commandHelp(group, name, command));
      return 0;
    }
    const expected = command.args?.length ?? 0;
    if (positionals.length > expected) throw new UsageError(`Unexpected "${positionals[expected]}".`);
    for (const [key, o] of Object.entries(command.options ?? {})) {
      if (o.required && values[key] === undefined) throw new UsageError(`--${key} is required.`);
    }
    let client: Skryvo | undefined;
    const key = command.offline ? "" : await apiKey(io.env, io);
    const result = await command.run({
      client: () => (client ??= clientFor(key, io.env)),
      values: values as Values,
      args: positionals,
      data: await data(values.data as string | undefined),
      progress: (line) => io.err(line),
    });
    show(result, Boolean(values.readable), io);
    return 0;
  } catch (error) {
    return report(error, wantsText, io);
  }
}
