import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "node18",
    sourcemap: false,
  },
  {
    entry: { cli: "src/cli/bin.ts" },
    format: ["esm"],
    target: "node20",
    sourcemap: false,
  },
]);
