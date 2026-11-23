import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where `skryvo login` keeps the key: one line, readable only by its owner. */
export function keyPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.SKRYVO_CONFIG_DIR) return join(env.SKRYVO_CONFIG_DIR, "api-key");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "skryvo", "api-key");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "skryvo", "api-key");
}

export async function readKey(path: string): Promise<{ key?: string; looseMode?: boolean }> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const key = text.trim() || undefined;
    return { key, looseMode: process.platform !== "win32" && (info.mode & 0o077) !== 0 };
  } catch {
    return {};
  }
}

export async function saveKey(path: string, key: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${key}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function forgetKey(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

/** A key typed at a hidden prompt, or piped in on stdin. */
export async function askForKey(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (value: string | Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      value instanceof Error ? reject(value) : resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return done(typed);
        if (char === "\u0003") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on("data", onData);
  });
}
