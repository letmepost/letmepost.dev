import { neonConfig, Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import ws from "ws";
import * as schema from "./schema/index.js";

export type DrizzleClient =
  | ReturnType<typeof drizzleNeon<typeof schema>>
  | ReturnType<typeof drizzlePg<typeof schema>>;

export type DbKind = "neon" | "postgres";

export interface DbHandle {
  db: DrizzleClient;
  kind: DbKind;
  close: () => Promise<void>;
}

function isNeonUrl(databaseUrl: string): boolean {
  try {
    const u = new URL(databaseUrl);
    return u.hostname.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

function readDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.length === 0) {
    throw new Error(
      "DATABASE_URL env var is not set. Add a Postgres connection string to apps/api/.env (see apps/api/.env.example).",
    );
  }
  return url;
}

/**
 * Build a Drizzle client. The driver is selected at runtime:
 *   - `.neon.tech` hostname → `@neondatabase/serverless` (WebSocket Pool, ideal for serverless)
 *   - anything else        → `postgres.js` (raw TCP, works for local dev / self-host / other Postgres)
 *
 * Both expose the same Drizzle query API, so callers never need to branch on `kind`.
 */
export function createDb(databaseUrl: string = readDatabaseUrl()): DbHandle {
  if (isNeonUrl(databaseUrl)) {
    neonConfig.webSocketConstructor = ws;
    const pool = new NeonPool({ connectionString: databaseUrl });
    const db = drizzleNeon(pool, { schema });
    return {
      db,
      kind: "neon",
      close: async () => {
        await pool.end();
      },
    };
  }

  const client = postgres(databaseUrl, { max: 10, prepare: false });
  const db = drizzlePg(client, { schema });
  return {
    db,
    kind: "postgres",
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

export { schema };
