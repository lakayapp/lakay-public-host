// Local replacement for `@hatch/space-sdk` (server side).
//
// The Lakay actions were written against the Muse space runtime. On the
// public host there is no Muse runtime, so this module provides the same
// surface the actions import: `defineAction`, `z`, and the `Ctx` /
// `ActionsModule` types. The real implementations live in ctx.ts; this file
// only declares the shapes so actions.ts compiles unchanged.

import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { z } from "zod";

export { z };

export const ACTION_BRAND = "@hatch/space-sdk/action/v1";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SpaceDb<TSchema extends Record<string, unknown> = Record<string, never>> =
  Pick<
    LibSQLDatabase<TSchema>,
    "select" | "insert" | "update" | "delete" | "run" | "all" | "get" | "batch"
  >;

export type SpaceDbAccessor = <
  TSchema extends Record<string, unknown> = Record<string, never>,
>() => SpaceDb<TSchema>;

export interface BlobMetadata {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly visibility: "private" | "public";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly public: boolean;
}

export interface BlobClient {
  put(
    key: string,
    data: string | ArrayBuffer | ArrayBufferView | Blob,
    options?: { contentType?: string; public?: boolean },
  ): Promise<void>;
  getUrl(key: string, options?: { expiresInSeconds?: number; public?: boolean }): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<BlobMetadata | null>;
  list(prefix?: string): Promise<BlobMetadata[]>;
}

export interface InferenceCompleteOptions<T extends z.ZodType = z.ZodType> {
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
  readonly images?: readonly { dataBase64: string; mimeType?: string; filename?: string; caption?: string }[];
}

export interface InferenceClient {
  complete<T extends z.ZodType>(
    prompt: string,
    options: InferenceCompleteOptions<T>,
  ): Promise<z.infer<T>>;
}

export type AgentTaskResult =
  | { ok: true; taskId: string; agentId: string; messageId: string }
  | { ok: false; error: string };

export interface AgentClient {
  spawnTask(
    message: string,
    options?: { expectsAction?: string; dedupeKey?: string; allowParallel?: boolean },
  ): Promise<AgentTaskResult>;
  send(
    message: string,
    options?: { expectsAction?: string; dedupeKey?: string; allowParallel?: boolean },
  ): Promise<AgentTaskResult>;
  status(taskId: string): Promise<{ taskId: string; status: string }>;
}

export interface Ctx {
  readonly slug: string;
  readonly invocationId: string;
  readonly spaceDir: string;
  readonly db: SpaceDbAccessor;
  readonly blobs: BlobClient;
  readonly inference: InferenceClient;
  readonly agent: AgentClient;
  readonly viewer?: unknown;
  emit(data: JsonValue): void;
  invalidateQueries(invalidation?: unknown): void;
  executePrivileged(...args: never[]): Promise<never>;
  tool: { [key: string]: never };
}

export interface ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly __brand: typeof ACTION_BRAND;
  readonly request: Req;
  readonly response: Res;
  readonly description?: string;
  readonly handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export type ActionsModule = Record<
  string,
  Omit<ActionDefinition, "handler"> & {
    handler: (ctx: Ctx, args: never) => Promise<unknown>;
  }
>;

export function defineAction<Req extends z.ZodType, Res extends z.ZodType>(spec: {
  request: Req;
  response: Res;
  description?: string;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  return { __brand: ACTION_BRAND, ...spec };
}

export class InferenceSchemaError extends Error {
  readonly __brand = "@hatch/space-sdk/InferenceSchemaError/v1" as const;
  readonly issues: readonly unknown[];
  constructor(issues: readonly unknown[]) {
    super("inference output did not match the required schema");
    this.issues = issues;
  }
  static is(value: unknown): value is InferenceSchemaError {
    return (
      value instanceof InferenceSchemaError ||
      (typeof value === "object" &&
        value !== null &&
        (value as { __brand?: unknown }).__brand ===
          "@hatch/space-sdk/InferenceSchemaError/v1")
    );
  }
}
