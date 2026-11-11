// Lakay public host: plain Node HTTP server.
//
// Routes:
//   GET  /                the Lakay web client (static build in ../public)
//   GET  /assets/*        client assets
//   POST /actions         the action RPC the client already speaks:
//                        { action, args, actionCallId } -> { data } | { error }
//   GET  /blobs/*         photos and videos members uploaded
//   GET  /citadelle.webp  Lakay's own images (also used as safe-source
//   GET  /konpa.webp      pictures for news posts)
//   GET  /healthz         liveness, no database needed
//   GET  /healthz/db      liveness plus a SELECT 1 against Turso
//   POST /cron/news       cron-job.org calls this seven times a day to
//   GET  /cron/news       start a news round; needs ?secret= or the
//                        x-cron-secret header matching CRON_SECRET
//
// Environment:
//   PORT, TURSO_URL, TURSO_AUTH_TOKEN, GEMINI_API_KEY, GEMINI_MODEL,
//   BLOB_DIR, PUBLIC_URL, CRON_SECRET

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Actions } from "./actions.js";
import { buildCtx } from "./ctx.js";

const PORT = Number(process.env.PORT ?? 3000);
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const BLOB_DIR = process.env.BLOB_DIR ?? "./data/blobs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};

let invocationCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function serveFile(res: ServerResponse, file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    const data = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handleActions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: { action?: unknown; args?: unknown };
  try {
    parsed = JSON.parse(await readBody(req, 40_000_000)) as typeof parsed;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const name = typeof parsed.action === "string" ? parsed.action : "";
  const definition = (Actions as Record<string, { request: { parse(a: unknown): unknown }; response: { parse(a: unknown): unknown }; handler: (ctx: unknown, args: never) => Promise<unknown> }>)[name];
  if (!definition) {
    sendJson(res, 400, { error: `action '${name}' is not defined` });
    return;
  }
  invocationCounter += 1;
  const ctx = buildCtx(`public-${Date.now()}-${invocationCounter}`);
  try {
    const args = definition.request.parse(parsed.args ?? {});
    const result = await definition.handler(ctx, args as never);
    const data = definition.response.parse(result);
    sendJson(res, 200, { data });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[lakay] action ${name} failed:`, message);
    sendJson(res, 200, { error: message });
  }
}

async function handleBlob(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
  const parts = key.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  const file = path.join(BLOB_DIR, ...parts.map(decodeURIComponent));
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let contentType = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    try {
      const meta = JSON.parse(await fs.readFile(`${file}.meta.json`, "utf8")) as {
        contentType?: string;
      };
      if (meta.contentType) contentType = meta.contentType;
    } catch {
      // No metadata sidecar; fall back to the extension guess.
    }
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

async function handleCronNews(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const secret = req.headers["x-cron-secret"] ?? url.searchParams.get("secret") ?? "";
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  invocationCounter += 1;
  const ctx = buildCtx(`cron-${Date.now()}-${invocationCounter}`);
  try {
    const result = await Actions.refreshDailyArticles.handler(ctx, {});
    sendJson(res, 200, { data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendJson(res, 200, { error: message });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === "POST" && pathname === "/actions") {
      await handleActions(req, res);
      return;
    }
    if ((req.method === "POST" || req.method === "GET") && pathname === "/cron/news") {
      await handleCronNews(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }
    if (req.method === "GET" && pathname === "/healthz/db") {
      try {
        const ctx = buildCtx(`healthz-${Date.now()}`);
        const db = ctx.db();
        // db.all runs a real round trip; a bare select() with no .from()
        // never executes and would report a false "ok".
        const rows = await db.all(sql`SELECT 1 AS ok`);
        const ok = Array.isArray(rows) && rows.length > 0;
        sendJson(res, 200, { ok, db: ok ? "ok" : "empty" });
      } catch (e) {
        sendJson(res, 200, {
          ok: false,
          db: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/blobs/")) {
      await handleBlob(req, res, pathname.slice("/blobs/".length));
      return;
    }
    if (req.method === "GET") {
      const file =
        pathname === "/"
          ? path.join(PUBLIC_DIR, "index.html")
          : path.join(PUBLIC_DIR, ...pathname.split("/").filter((p) => p !== "" && p !== "." && p !== ".."));
      if (await serveFile(res, file)) return;
      // Single-page fallback: unknown paths serve the app shell.
      if (await serveFile(res, path.join(PUBLIC_DIR, "index.html"))) return;
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[lakay] request failed:", e);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[lakay] public host listening on :${PORT}`);
});
