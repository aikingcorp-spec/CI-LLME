// No-Docker mode for the e2e/integration harness (see harness.ts).
//
// Set E2E_LOCAL_PG_ADMIN_URL to the admin URL of an existing Postgres server, for example
// postgresql://postgres@127.0.0.1:54329/postgres, and the harness creates one fresh database per
// run instead of starting a PostgreSqlContainer. `psql` must be on PATH. The database is named
// `<prefix>_<yyyymmddhhmmss>_<pid>` (prefix: E2E_LOCAL_DB_PREFIX, default `kai_e2e`), integration
// suites clone it as `<name>_s<index>`, and only databases created in this run are dropped.

/** Databases a local run must never create or drop: shared fixtures of other tools. */
const PROTECTED_NAME = "rakazo_e2e";
const PROTECTED_PREFIXES = ["leo_"];
const MAX_IDENTIFIER_LENGTH = 63;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export const DEFAULT_LOCAL_DB_PREFIX = "kai_e2e";

export function assertSafeLocalDatabaseName(name: string): void {
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Refusing unsafe local database name "${name}"`);
  }
  if (name === PROTECTED_NAME || PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`Refusing protected local database name "${name}"`);
  }
}

/** `<prefix>_<yyyymmddhhmmss>_<pid>`, timestamp in UTC. */
export function localDatabaseName(prefix: string, now: Date, pid: number): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll(/[-:T]/g, "");
  const name = `${prefix}_${stamp}_${pid}`;
  assertSafeLocalDatabaseName(name);
  return name;
}

/** Keeps the run database and its suite clones; the only names a local run may drop. */
export class LocalDatabases {
  readonly #created = new Set<string>();

  constructor(private readonly run: (statement: string) => Promise<void>) {}

  get created(): readonly string[] {
    return [...this.#created];
  }

  async create(name: string, template?: string): Promise<void> {
    assertSafeLocalDatabaseName(name);
    if (template !== undefined && !this.#created.has(template)) {
      throw new Error(`Refusing to clone "${template}": this run did not create it`);
    }
    await this.run(
      `CREATE DATABASE "${name}"${template === undefined ? "" : ` TEMPLATE "${template}"`}`,
    );
    this.#created.add(name);
  }

  async drop(name: string): Promise<void> {
    assertSafeLocalDatabaseName(name);
    if (!this.#created.has(name)) {
      throw new Error(`Refusing to drop "${name}": this run did not create it`);
    }
    await this.run(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    this.#created.delete(name);
  }

  /** Drops everything this run created, clones first. Tries all and reports the first failure. */
  async dropAll(): Promise<void> {
    let failure: unknown;
    for (const name of [...this.#created].reverse()) {
      try {
        await this.drop(name);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}

/** The same server and login as `base`, pointed at another database. */
export function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}
