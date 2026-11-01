import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { KeyPair } from "@rakazo/p2p-prototype/pairing";
import type { Deps, RoomStub } from "./app.js";
import type { AppTokenClaims } from "./app-token.js";
import { TOKEN_TYP } from "./app-token.js";
import type { Config } from "./config.js";
import { sign, toBase64Url, utf8 } from "./crypto.js";

const MIGRATIONS = fileURLToPath(new NodeURL("../migrations/", import.meta.url));
type SqlValue = null | number | bigint | string;

/** A D1 look-alike over a real in-memory SQLite database with the shipped migration applied. */
export function createD1(): { d1: D1Database; sql: DatabaseSync } {
  const sql = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sql.exec(readFileSync(`${MIGRATIONS}/${file}`, "utf8"));
  }

  class Statement {
    constructor(
      readonly query: string,
      readonly params: SqlValue[] = [],
    ) {}
    bind(...params: SqlValue[]): Statement {
      return new Statement(this.query, params);
    }
    async first<T>(): Promise<T | null> {
      return (sql.prepare(this.query).get(...this.params) as T | undefined) ?? null;
    }
    async all<T>(): Promise<{ results: T[] }> {
      return { results: sql.prepare(this.query).all(...this.params) as T[] };
    }
    async run(): Promise<{ meta: { changes: number } }> {
      const { changes } = sql.prepare(this.query).run(...this.params);
      return { meta: { changes: Number(changes) } };
    }
  }

  const d1 = {
    prepare: (query: string) => new Statement(query),
    async batch(statements: Statement[]) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, sql };
}

export const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);

export const TEST_ISSUER = "https://app.example.test";
export const TEST_AUDIENCE = "p2p.example.test";

export function testConfig(gatewayKey: KeyPair, appKeys: Record<string, string>): Config {
  return {
    gatewayKey,
    gatewayKeyId: "gw-test",
    appKeys,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    allowedOrigins: ["https://app.example.test"],
  };
}

const segment = (value: unknown): string => toBase64Url(utf8(JSON.stringify(value)));

/** An app token as `POST /api/p2p/token` would mint it; override any claim or header field. */
export async function signAppToken(
  key: KeyPair,
  o: {
    nowMs: number;
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
  },
): Promise<string> {
  const iat = Math.floor(o.nowMs / 1000);
  const header = segment({ alg: "EdDSA", typ: TOKEN_TYP, kid: "app-test", ...o.header });
  const payload = segment({
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: "user-1",
    email: "one@example.test",
    iat,
    nbf: iat,
    exp: iat + 300,
    jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    scope: ["pair", "session", "nodes", "turn"],
    ...o.claims,
  } satisfies Partial<Record<keyof AppTokenClaims | string, unknown>>);
  return `${header}.${payload}.${await sign(key, `${header}.${payload}`)}`;
}

export interface FakeRoom extends RoomStub {
  requests: Request[];
  kicked: number;
  isOnline: boolean;
}

/** Records what the Worker forwards instead of running a Durable Object. */
export function fakeRooms(): { room: Deps["room"]; rooms: Map<string, FakeRoom> } {
  const rooms = new Map<string, FakeRoom>();
  const room = (nodeId: string): FakeRoom => {
    let r = rooms.get(nodeId);
    if (r === undefined) {
      const created: FakeRoom = {
        requests: [],
        kicked: 0,
        isOnline: false,
        fetch: async (request) => {
          created.requests.push(request);
          return new Response("forwarded", { status: 200 });
        },
        online: async () => created.isOnline,
        kick: async () => {
          created.kicked++;
        },
      };
      rooms.set(nodeId, created);
      r = created;
    }
    return r;
  };
  return { room, rooms };
}
