// Applies the Lakay Drizzle migrations to the Turso database, in order.
//
// Usage:
//   TURSO_URL=https://lakay-lakay.turso.io TURSO_AUTH_TOKEN=<token> node migrate.mjs
//
// The migration SQL files live in the Lakay artifact's drizzle/ folder and
// are copied here under ./drizzle at deploy time (Render build command does
// this; see README.md). Each file is split into statements and run through
// the libSQL HTTP pipeline. Applied files are recorded in
// _lakay_migrations so re-runs only apply new ones.
//
// This script never prints the token.

import { promises as fs } from "node:fs";
import path from "node:path";

const TURSO_URL = (process.env.TURSO_URL ?? "https://lakay-lakay.turso.io").replace(/\/$/, "");
const TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? "./drizzle";

if (!TOKEN) {
  console.error("TURSO_AUTH_TOKEN is not set.");
  process.exit(1);
}

async function pipeline(statements) {
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      requests: [
        ...statements.map((sql) => ({ type: "execute", stmt: { sql } })),
        { type: "close" },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`pipeline ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const results = data.results ?? [];
  for (const r of results) {
    if (r.type === "error") throw new Error(`SQL error: ${JSON.stringify(r.error).slice(0, 400)}`);
  }
  return data;
}

function splitStatements(sqlText) {
  // Drizzle files separate statements with `--> statement-breakpoint`
  // lines; statements themselves end with `;`.
  const out = [];
  for (const chunk of sqlText.split(/--> statement-breakpoint/g)) {
    for (const part of chunk.split(/;\s*\n/)) {
      const s = part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (s.length > 0) out.push(`${s};`);
    }
  }
  return out;
}

async function appliedMigrations() {
  await pipeline([
    "CREATE TABLE IF NOT EXISTS _lakay_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);",
  ]);
  const out = await pipeline(["SELECT name FROM _lakay_migrations;"]);
  const rows = out.results?.[0]?.response?.result?.rows ?? [];
  return new Set(rows.map((r) => r[0]?.value));
}

const files = (await fs.readdir(MIGRATIONS_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const applied = await appliedMigrations();
for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip ${file} (already applied)`);
    continue;
  }
  const text = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
  const statements = splitStatements(text);
  console.log(`apply ${file} (${statements.length} statement(s))`);
  await pipeline(statements);
  await pipeline([
    `INSERT INTO _lakay_migrations (name, applied_at) VALUES ('${file}', ${Date.now()});`,
  ]);
}
console.log("migrations done");
