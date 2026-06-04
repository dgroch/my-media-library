// Shared env loader for the build/index scripts. Merges .env.local (for local
// runs) under process.env (which wins, e.g. on Render). Mirrors the tiny loader
// in build-index.mjs so the standalone scripts behave identically.

import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env.local") {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export const env = { ...loadEnv(), ...process.env };
