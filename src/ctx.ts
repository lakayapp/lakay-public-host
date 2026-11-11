// Runtime implementations of the Lakay action context for the public host.
//
// - db: drizzle-orm over @libsql/client/web (pure fetch, no native bindings),
//   pointed at the Turso database. This is the same drizzle surface the
//   actions were written against (select/insert/update/delete), so the
//   action code runs unchanged.
// - inference: Google Gemini REST (gemini-3.5-flash by default), replacing
//   the Muse managed inference. Structured output is requested as JSON and
//   validated with the caller's zod schema.
// - blobs: local disk under BLOB_DIR, served back at /blobs/<key>.
// - agent.spawnTask: the news journalist. There is no Muse agent on the
//   public host, so a round runs the RSS-only journalist in-process
//   (see journalist.ts) instead of spawning a research task.
// - invalidateQueries / emit: no-ops. The web client refetches after
//   mutations; there is no live-query push channel on the public host.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import { z } from "zod";
import {
  InferenceSchemaError,
  type AgentTaskResult,
  type BlobClient,
  type BlobMetadata,
  type Ctx,
  type InferenceClient,
} from "./shim.js";

const TURSO_URL = process.env.TURSO_URL ?? "https://lakay-lakay.turso.io";
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
const BLOB_DIR = process.env.BLOB_DIR ?? "./data/blobs";

if (!TURSO_AUTH_TOKEN) {
  console.warn("[lakay] TURSO_AUTH_TOKEN is not set; database calls will fail until it is set.");
}
if (!GEMINI_API_KEY) {
  console.warn("[lakay] GEMINI_API_KEY is not set; translations and news rounds will fail until it is set.");
}

// ---------------------------------------------------------------- db
const libsql = createClient({ url: TURSO_URL, authToken: TURSO_AUTH_TOKEN });
const db = drizzle(libsql);

function dbAccessor() {
  return db as never;
}

// ---------------------------------------------------------------- inference
function isZodString(schema: z.ZodType): boolean {
  return schema instanceof z.ZodString;
}

async function geminiGenerate(
  prompt: string,
  system: string | undefined,
  wantJson: boolean,
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        ...(wantJson ? { responseMimeType: "application/json" } : {}),
      },
    };
    if (system) {
      body.system_instruction = { parts: [{ text: system }] };
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[{[]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("model reply was not valid JSON");
  }
}

const inference: InferenceClient = {
  async complete(prompt, options) {
    const timeoutMs = (options.timeout_secs ?? 45) * 1000;
    const wantJson = !isZodString(options.schema);
    const fullPrompt = wantJson
      ? `${prompt}\n\nReturn ONLY a JSON value matching the requested shape. No prose, no markdown fences.`
      : prompt;
    const raw = await geminiGenerate(fullPrompt, options.system, wantJson, timeoutMs);
    if (!wantJson) {
      const parsed = options.schema.safeParse(raw);
      if (!parsed.success) throw new InferenceSchemaError(parsed.error.issues);
      return parsed.data;
    }
    let value: unknown;
    try {
      value = extractJson(raw);
    } catch (e) {
      throw new InferenceSchemaError([
        { message: e instanceof Error ? e.message : "bad JSON" },
      ]);
    }
    const parsed = options.schema.safeParse(value);
    if (!parsed.success) throw new InferenceSchemaError(parsed.error.issues);
    return parsed.data;
  },
};

// ---------------------------------------------------------------- blobs
function safeBlobPath(key: string): string {
  const parts = key.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  return path.join(BLOB_DIR, ...parts);
}

const blobs: BlobClient = {
  async put(key, data, options) {
    const file = safeBlobPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const buf =
      typeof data === "string"
        ? Buffer.from(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data as unknown as Uint8Array);
    await fs.writeFile(file, buf);
    await fs.writeFile(
      `${file}.meta.json`,
      JSON.stringify({
        contentType: options?.contentType ?? "application/octet-stream",
        createdAtMs: Date.now(),
      }),
    );
  },
  async getUrl(key) {
    return `/blobs/${key.split("/").map(encodeURIComponent).join("/")}`;
  },
  async delete(key) {
    const file = safeBlobPath(key);
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.meta.json`, { force: true });
  },
  async head(key): Promise<BlobMetadata | null> {
    const file = safeBlobPath(key);
    try {
      const stat = await fs.stat(file);
      let contentType = "application/octet-stream";
      try {
        const meta = JSON.parse(await fs.readFile(`${file}.meta.json`, "utf8")) as {
          contentType?: string;
          createdAtMs?: number;
        };
        contentType = meta.contentType ?? contentType;
        return {
          key,
          contentType,
          size: stat.size,
          sizeBytes: stat.size,
          etag: `${stat.size}-${stat.mtimeMs}`,
          visibility: "public",
          createdAtMs: meta.createdAtMs ?? stat.birthtimeMs,
          updatedAtMs: stat.mtimeMs,
          public: true,
        };
      } catch {
        return {
          key,
          contentType,
          size: stat.size,
          sizeBytes: stat.size,
          etag: `${stat.size}-${stat.mtimeMs}`,
          visibility: "public",
          createdAtMs: stat.birthtimeMs,
          updatedAtMs: stat.mtimeMs,
          public: true,
        };
      }
    } catch {
      return null;
    }
  },
  async list(prefix = ""): Promise<BlobMetadata[]> {
    const out: BlobMetadata[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), relPath);
        else if (!e.name.endsWith(".meta.json")) {
          const meta = await blobs.head(relPath);
          if (meta && relPath.startsWith(prefix)) out.push(meta);
        }
      }
    }
    await walk(BLOB_DIR, "");
    return out;
  },
};

// ---------------------------------------------------------------- agent (news rounds)
const runningRounds = new Map<string, Promise<void>>();
let roundCounter = 0;

async function runRoundInBackground(roundKey: string): Promise<void> {
  const { runJournalistRound } = await import("./journalist.js");
  const ctx = buildCtx(`journalist-${roundKey}`);
  try {
    await runJournalistRound(ctx, roundKey);
  } catch (e) {
    console.error(`[lakay] journalist round ${roundKey} failed:`, e);
  } finally {
    runningRounds.delete(roundKey);
  }
}

// ---------------------------------------------------------------- ctx
export function buildCtx(invocationId: string): Ctx {
  return {
    slug: "lakay",
    invocationId,
    spaceDir: process.cwd(),
    db: dbAccessor as Ctx["db"],
    blobs,
    inference,
    agent: {
      async spawnTask(_message, options): Promise<AgentTaskResult> {
        const roundKey = options?.dedupeKey ?? `round-${Date.now()}`;
        const existing = runningRounds.get(roundKey);
        if (existing) {
          return { ok: true, taskId: roundKey, agentId: "public-host", messageId: roundKey };
        }
        roundCounter += 1;
        const taskId = `${roundKey}-${roundCounter}`;
        const run = runRoundInBackground(roundKey);
        runningRounds.set(roundKey, run);
        return { ok: true, taskId, agentId: "public-host", messageId: taskId };
      },
      async send(message, options) {
        return this.spawnTask(message, options);
      },
      async status(taskId) {
        return {
          taskId,
          status: runningRounds.has(taskId) ? "running" : "completed",
        };
      },
    },
    emit() {},
    invalidateQueries() {},
    async executePrivileged() {
      throw new Error("executePrivileged is not available on the public host");
    },
    tool: {},
  };
}

export { TURSO_URL };
