const scalar = (v: unknown) => v === null || v === undefined || typeof v !== "object";

function text(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") return v.includes("\n") ? `\n${v.replace(/^/gm, "    ")}` : v;
  return String(v);
}

function lines(value: unknown, indent: string): string[] {
  if (scalar(value)) return [`${indent}${text(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}(none)`];
    if (value.every(scalar)) return [`${indent}${value.map(text).join(", ")}`];
    return value.flatMap((item, i) => [...(i ? [""] : []), ...lines(item, indent)]);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [`${indent}(empty)`];
  return entries.flatMap(([key, v]) => {
    if (scalar(v) || (Array.isArray(v) && v.every(scalar))) {
      return [`${indent}${key}: ${Array.isArray(v) ? (v.length ? v.map(text).join(", ") : "(none)") : text(v)}`];
    }
    return [`${indent}${key}:`, ...lines(v, `${indent}  `)];
  });
}

/** The CLI's --readable view: one field per line, nested fields indented, list items apart. */
export function readable(value: unknown): string {
  return lines(value, "").join("\n");
}
