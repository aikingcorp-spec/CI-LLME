# Rakazo baseline system map

Frozen at commit `c4b24547`. This file is the imported Rakazo tree and is not edited except to fix a typo. VNBot deltas live in `docs/architecture/vnbot/` and must not be written back here.

Source identifiers, package names, the database role, and the realtime channel say Rakazo. Do not rename them in code, and do not edit `LICENSE` for a naming change. There is no `NOTICE` file in this tree.

Every path below is a file an agent can open. Symbols are named next to the path. Deeper narrative that this map does not repeat:

- Run dispatch timing: `docs/run-execution.md`
- Computer runtime: `docs/computer-runtime.md`
- Sandbox providers for self-host: `docs/self-host-sandbox-providers.md`
- Secrets and Infisical: `docs/bot-secrets.md`, `docs/self-host-secrets.md`, `docs/infisical-secrets.md`
- Content encryption: `docs/content-encryption.md`
- Self-host and database roles: `docs/self-host.md`

The owner-facing baseline (Vietnamese) is `docs/architecture/rakazo-baseline/ban-do-rakazo-goc.md`.

## Monorepo and build

pnpm workspace `pnpm-workspace.yaml` includes `apps/*`, `packages/*`, `infra/sandboxes/supervisor`, and `infra/updater`. Root `package.json` (`name` `rakazo`) pins `packageManager` `pnpm@9.15.0` and Node `^22.22.2 || ^24.0.0 || >=26.0.0`. Node 23 and 25 are unsupported (`README.md`).

Turbo (`turbo.json`) tasks:

| Task | Depends on | Notes |
| --- | --- | --- |
| `build` | `^build`, `^generate` | Outputs `dist/**`, `src/generated/**`. Passes `BETTER_AUTH_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY`, `GIT_SHA`, and the public PostHog/Crisp vars. |
| `check` | `^check`, `^generate`, `generate` | Typecheck. |
| `test` | `^generate` | |
| `dev` | persistent | Passes `RAKAZO_HOST`, `RAKAZO_DEV_HOST`, `RAKAZO_ALLOWED_HOSTS`. |
| `generate` | uncached | Prisma client and CSS tokens. |

`turbo.json` `globalDependencies` includes `scripts/build-server.mjs`. API and worker build with that script (`apps/api/package.json` `build`, `apps/worker/package.json` `build`). Lint is Biome: root `package.json` script `lint` runs `biome check .`.

`pnpm dev` is `scripts/dev.mjs`. It starts `@rakazo/api`, `@rakazo/worker`, `@rakazo/web`, and `@rakazo/sandbox-supervisor` (ports web `5173`, api `3100`, supervisor `7091` unless overridden).

| Package | Path | Role |
| --- | --- | --- |
| `@rakazo/web` | `apps/web/package.json` | Vite + React 19 SPA. oRPC client, Lingui, Tailwind. |
| `@rakazo/desktop` | `apps/desktop/package.json` | Electron shell. `productName` is Rakazo. Bundles `apps/web` `dist` as `extraResources`. |
| `@rakazo/mobile` | `apps/mobile/package.json` | Expo Router app. Native modules under `apps/mobile/modules/`. |
| `@rakazo/api` | `apps/api/package.json` | Hono HTTP server. Exports `./app` from `apps/api/src/app.ts`. |
| `@rakazo/worker` | `apps/worker/package.json` | Background execution. No HTTP product API. |
| `@rakazo/www` | `apps/www/package.json` | Astro marketing site. Not part of `pnpm dev`. |
| `@rakazo/contracts` | `packages/contracts/package.json` | Zod + oRPC contract (`packages/contracts/src/rpc.ts`). |
| `@rakazo/core` | `packages/core/package.json` | Pure domain rules (run state, approvals, cron, locale matching). |
| `@rakazo/db` | `packages/db/package.json` | Prisma schema, client, RLS, repositories. |
| `@rakazo/auth` | `packages/auth/package.json` | Better Auth composition. |
| `@rakazo/adapter-kit` | `packages/adapter-kit/package.json` | Provider interfaces and job payload schemas. No vendor SDKs. |
| `@rakazo/adapters` | `packages/adapters/package.json` | Vendor SDKs and the run executor. |
| `@rakazo/memory` | `packages/memory/package.json` | `MarkdownMemoryStore`. |
| `@rakazo/ui-tokens` | `packages/ui-tokens/package.json` | Semantic colors. `generate` runs `packages/ui-tokens/src/generate-css.ts`. |
| `@rakazo/ui-web` | `packages/ui-web/package.json` | Vendored shadcn/Base UI. |
| `@rakazo/chat-ui` | `packages/chat-ui/package.json` | Shared markdown (`./web`, `./native`). |
| `@rakazo/logging` | `packages/logging/package.json` | Logger, Hono request log, optional Axiom. |
| `@rakazo/testkit` | `packages/testkit/package.json` | Offline harnesses invoked from the root `test:*` scripts. |
| `@rakazo/sandbox-supervisor` | `infra/sandboxes/supervisor/package.json` | Docker computer control plane. |

## Runtime processes

```text
browser / Electron renderer / Expo
        |  HTTPS or Vite proxy
        v
@rakazo/api   (Hono)  --pg_notify-->  Postgres  <--LISTEN--  @rakazo/worker
        |                               ^  |                      |
        |                               |  | Graphile jobs        | SandboxProvider
        +-------- Prisma (rakazo_app) --+  +----------------------+
                                          supervisor :7091 (docker only)
                                                 |
                                          computer containers
```

- API process name on the pool: `rakazo-api` (`apps/api/src/app.ts`, `createDb` `applicationName`). A second pool `rakazo-api-jobs` publishes Graphile work.
- Worker pool name: `rakazo-worker` (`apps/worker/src/index.ts`). `DB_POOL_MAX` must be at least 6 when `WAKEUP_DRIVER` is not `memory`, because Graphile listeners plus leadership share the pool.
- Both processes call `contentKeyProviderFromEnv`, `createSecretStore` / `createWorkerSecretStore`, `createThreadEvents`, `resolveSandboxProvider`, `createRunSandbox`, `PiAgentRuntime` or `ScriptedAgentRuntime`, and `createBackgroundJobHandlers`. They must share `DATABASE_URL`, `ENCRYPTION_KEY`, and sandbox settings or they will disagree about ciphertext and computers.
- Realtime is one Postgres channel, `rakazo_events` (`POSTGRES_CHANNEL` in `packages/adapters/src/realtime.ts`). `PostgresRealtimeFanout.publish` runs `SELECT pg_notify($1, $2)`. Payloads over `MAX_NOTIFY_PAYLOAD_BYTES` (7900) throw. Listeners `LISTEN rakazo_events`. A lost notification is recovered by a scan; NOTIFY is a hint (`RunJobPublisher` in `packages/adapters/src/run-wakeup.ts`).
- Agent runs are rows, not Graphile jobs. `RunJobPublisher.enqueue` writes `Run.wakeAt` for `run.continue` and publishes topic `runs:ready` (`RUN_READY_TOPIC`). Other job names go to the inner publisher (`GraphileJobPublisher` in `packages/adapters/src/wakeup.ts`, or `InMemoryJobQueue` when `WAKEUP_DRIVER=memory`).
- `RunWorkerHost.start` (`packages/adapters/src/run-wakeup.ts`) subscribes to `runs:ready` and scans every `intervalMs` (default 5000). The scan is `runAsSystem("run recovery scan", ...)`. Claiming is `createRunExecutor(...).continueRun` in `packages/adapters/src/executor.ts`.
- The model loop is `PiAgentRuntime` (`packages/adapters/src/pi-runtime.ts`) unless `AGENT_RUNTIME=scripted`, which selects `ScriptedAgentRuntime` (`apps/worker/src/index.ts`).
- Docker computers: API and worker talk to `@rakazo/sandbox-supervisor` at `SANDBOX_SUPERVISOR_URL` (default `http://127.0.0.1:7091`). The supervisor is `infra/sandboxes/supervisor/src/index.ts`. The guest image is `infra/sandboxes/computer/Dockerfile`.
- Web dev proxy: `apps/web/vite.config.ts` proxies `/rpc`, `/api`, and `/novnc` to `API_PROXY_TARGET` (default `http://127.0.0.1:3100`).
- Auth HTTP is mounted at `/api/auth/*` and product RPC at `/rpc/*` (`apps/api/src/app.ts`, `RPCHandler` with `prefix: "/rpc"`).

`createRouter` (`apps/api/src/router.ts`) spreads these route modules onto one oRPC router:

`accountRoutes`, `spacesRoutes`, `modelsRoutes`, `botsRoutes`, `threadsRoutes`, `computerRoutes`, `memoryRoutes`, `routinesRoutes`, `boardsRoutes`, `mcpRoutes`, `availabilityRoutes`, `connectionsRoutes`, `messagingRoutes`, `contentRoutes`, `paymentWalletRoutes`.

The contract for those keys is `packages/contracts/src/rpc.ts`. Web calls it with `createORPCClient` in `apps/web/src/lib/rpc.ts`. Mobile posts `fetch(\`${apiBase}/rpc/${proc}\`)` in `apps/mobile/lib/api.ts` and checks `GET /rpc/health` from `apps/mobile/lib/endpoint.ts`.

## Data model and invariants

Schema: `packages/db/prisma/schema.prisma`. Status and kind strings are Zod enums in `packages/contracts/src/ids.ts` (`RunStatus`, `EffectStatus`, `SandboxKind`), not Prisma enums.

Tenancy is `Organization` → `Space` → rows that carry `spaceId`. A signed-in caller is an `Actor` (`userId`, `spaceId`, `email`) in `packages/contracts/src/ids.ts`. `Actor.isDeploymentOwner` is deprecated and always false.

Signup provisions a personal org and space in `bootstrapUserSpace` (`packages/db/src/bootstrap-user.ts`): `Organization.slug` `user-${id.slice(0,12)}`, `Member.role` `owner`, `Space.id` equal to that organization id, `Space.name` `"Personal"`, `Space.isDefault` true, `SpaceMember.role` `owner`.

### Thread ownership

`Thread.botId`, `Thread.groupId`, and `Thread.externalConversationId` are each optional and `@unique` (`model Thread`). SQL constraint `threads_owner_chk` requires exactly one of them to be non-null:

`packages/db/prisma/migrations/20260906120000_messaging_team_chat/migration.sql`

`num_nonnulls("botId", "groupId", "externalConversationId") = 1`.

So each bot has one thread, each chat group has one thread, and each external conversation has one thread. A bot thread is created inside `Repos.createBot` (`packages/db/src/repos.ts`) in the same transaction as the bot, its team `Computer`, `BrowserProfile`, and `MEMORY.md` `MemoryDocument`.

`Message` is unique on `(threadId, seq)` and `(threadId, clientNonce)`. `Event` is unique on `(threadId, seq)`. `Thread.nextMessageSeq` and `Thread.nextEventSeq` allocate those sequences.

### Run

`model Run` columns that matter for control:

- `status` — see lifecycle below.
- `trigger` — conversational vs isolated. `isConversationalRun` / `runReadsThreadHistory` in `packages/core/src/run-state.ts`. Non-conversational triggers: `routine`, `webhook`, `created`, `tickets`, `bot_message`. Background (hidden from the chat transcript): `tickets` (`BACKGROUND_RUN_TRIGGERS`).
- `leaseOwner`, `leaseFence`, `leaseExpiresAt` — worker ownership. `nextFence` increments the fence.
- `wakeAt` — null means runnable immediately when queued.
- `checkpoint` — resume cursor.
- `clientNonce` unique per space (`@@unique([spaceId, clientNonce])`).
- `retryOfRunId` `@unique` — a run is retried at most once.
- `firstResponseAt` — first visible output; kept across attempts (`docs/run-execution.md`).

`ExternalEffect.idempotencyKey` is unique. `SteeringMessage` is unique on `(messageId, botId)`.

### Computer

`Computer.scope` is `team` or `dedicated` (check in `packages/db/prisma/migrations/0008_team_computers/migration.sql`). `scopeKey` and `homeKey` are unique. Control of the screen is `controlHolder`, `controlLeaseId`, `controlLeaseExpiresAt`, `controlBotId`, `controlRunId`, `controlFence`. Execution ownership is also denormalized on the computer (`executionRunId`, `executionBotId`, `executionLeaseExpiresAt`, `executionFence`) and as rows in `ComputerExecutionLease`, unique on `(computerId, botId)`.

`ComputerRun` records billable uptime and is not deleted with the computer (`computerId` is not a relation).

### Vault and secrets

Three different stores:

| Model | Meaning |
| --- | --- |
| `VaultCredential` | The member's login vault. `spaceId` null is the account vault every space uses. A space that overrides `"credentials"` uses its own rows. |
| `BotSecret` | Older per-bot rows. The vault migration is additive and says `bot_secrets` stays until a later deploy (`packages/db/prisma/migrations/20261027120000_vault_credentials/migration.sql`). |
| `Secret` / `AgentSecret` | Space-level named secrets. `AgentSecret.name` matches `^[A-Z_][A-Z0-9_]{0,63}$` (`packages/db/prisma/migrations/20260906120100_agent_secrets/migration.sql`). |
| `UserModelCredential`, `UserVoiceCredential` | Bring-your-own model and speech keys. |

`VaultCredential` uniqueness is raw SQL, not a Prisma `@@unique`, because it needs `NULLS NOT DISTINCT`:

`vault_credentials_userId_spaceId_name_key` on `("userId", "spaceId", "name")` in `packages/db/prisma/migrations/20261027120000_vault_credentials/migration.sql`.

Ciphertext is written through `SecretStore` (`packages/adapter-kit/src/interfaces.ts`). `createSecretStore` (`packages/adapters/src/secret-store-factory.ts`) wraps `EncryptedSecretStore` and, when configured, `InfisicalSecretStore`.

### Row-level security

`installDbContext` (`packages/db/src/row-security.ts`) sets on each pooled connection:

`app.space_id`, `app.user_id`, `app.rls_bypass`, `app.rls_version` (constant `RLS_VERSION` `"2"`).

- `runAsTenant({ spaceId, userId }, fn)` sets the tenant pair and bypass `off`.
- `runAsSystem(reason, fn)` sets bypass `on`. The reason string is the audit trail (`grep` the call sites).
- No context: settings are empty and bypass `off`. Protected tables return no rows and reject writes.

Policies are SQL migrations, not Prisma. The first batch is `packages/db/prisma/migrations/20261021140000_row_level_security/migration.sql` (`threads`, `messages`, `events`, memory, artifacts, secrets, credentials, skills). The second batch is `packages/db/prisma/migrations/20261022120000_row_level_security_tenant_tables/migration.sql`: each table gets `*_system` (`app.rls_bypass = 'on'`), `*_tenant` (`"spaceId" = app.space_id`), and `*_previous_release` (`app_rls_version() < 2`) so the previous process keeps working during a rolling deploy. Later migrations add the same shape for newer tables (vault policies are in the vault migration: tenant matches `app.user_id`, and `spaceId` is null or the current space).

The model list the app knows is protected is `ROW_SECURITY_MODELS` in `packages/db/src/row-security.ts`.

The runtime login is the group role `rakazo_app` (`RUNTIME_ROLE` in `packages/db/src/database-access.ts`). Migrations use `DATABASE_MIGRATION_URL` (owner). The app uses `DATABASE_URL` (member of `rakazo_app`). If those URLs share one login, RLS is not enforced (`SINGLE_DATABASE_URL_WARNING`).

Table owner and superuser bypass RLS. That is why the app login must not be the migration owner.

## Request flow by surface

1. Browser loads the Vite SPA (`apps/web`). Cookies/session go to `/api/auth/*`. Product calls go to `/rpc/*`. In dev, Vite proxies both to the API. In Compose, `web` publishes the UI and reverse-proxies the API (`infra/compose/docker-compose.yml` service `web`).
2. `apps/api/src/app.ts` builds the Hono app: CORS, client IP (`TRUSTED_PROXIES`), body limits, CSP report, health, billing webhook, messaging webhooks, voice HTTP, user-device routes, screen proxy, then Better Auth `auth.handler` on `/api/auth/*` and `RPCHandler` on `/rpc/*`.
3. RPC handlers resolve the session to an `Actor`, then `runAsTenant` for that space (see route modules under `apps/api/src/routes/`). Cross-tenant work (dispatch, webhooks before a tenant is known) uses `runAsSystem` with a reason.
4. A chat send is `threads.send` → `sendThreadMessage` (`apps/api/src/routes/threads.ts`). It refuses when `modelSetup` says `needsModel` (`MODEL_REQUIRED_SEND_ERROR`).
5. The handler commits the `Message` and a `Run` (`status` `queued`) and enqueues `run.continue` through `RunJobPublisher`, which only stamps `wakeAt` and notifies. The worker scan claims the row.
6. Thread live updates: `createThreadEvents` (`packages/db/src/events.ts`) writes `Event` rows and `notify(threadId, seq)`. Clients subscribe with `threads.subscribe` (web oRPC event iterator; mobile `POST /rpc/threads/subscribe` in `apps/mobile/lib/api.ts`). `ProductEventType` `"heartbeat"` is liveness only: never persisted, seq 0 (`packages/contracts/src/events.ts`).

Desktop (`apps/desktop/src/main.ts`) is an Electron host for that same web UI:

- Existing server: the window loads the remote origin (`setup-config.ts` helpers imported by `main.ts`).
- Local stack: `LocalStackController` (`apps/desktop/src/local-stack.ts`) runs the Compose images and opens the bundled or local web URL.
- Signed-in desktop can expose the user's computer to bots through `startUserDeviceClient` (`packages/adapters/src/user-device-client.ts`, wired in `apps/desktop/src/user-device.ts`). `USER_DEVICES_ENABLED=false` turns that off.

Mobile (`apps/mobile`) is a separate UI on the same `/rpc` and `/api/auth` surface. Auth uses the Better Auth Expo plugin (`expo()` in `packages/auth/src/index.ts`). Trusted native origins include `rakazo://` (`MOBILE_AUTH_ORIGINS` in `apps/api/src/app.ts`). Push uses `ExpoPushProvider` when `EXPO_ACCESS_TOKEN` is set.

`apps/www` does not call the product RPC for chat. It is the public site (`apps/www/src/pages/index.astro` and sibling pages).

## Run and event lifecycle

Legal statuses (`RunStatus` in `packages/contracts/src/ids.ts`):

`queued`, `leased`, `running`, `waiting_input`, `waiting_takeover`, `completed`, `failed`, `cancelled`.

Transitions (`canTransition` / `assertTransition` in `packages/core/src/run-state.ts`):

| From | To |
| --- | --- |
| `queued` | `leased`, `cancelled` |
| `leased` | `running`, `queued`, `cancelled` |
| `running` | `waiting_input`, `waiting_takeover`, `completed`, `failed`, `cancelled`, `leased` |
| `waiting_input` | `queued`, `leased`, `cancelled` |
| `waiting_takeover` | `queued`, `leased`, `cancelled` |
| `completed` | (none) |
| `failed` | `queued` |
| `cancelled` | (none) |

`waiting_input` does not hold the queue (`QUEUE_HOLDING_RUN_STATUSES`). `waiting_takeover` does.

Claim path (`continueRun` in `packages/adapters/src/executor.ts`):

1. Ignore terminal rows (`isTerminal`).
2. `updateMany` to `leased` only if status is `queued` / `waiting_input` / `waiting_takeover`, or `leased` / `running` with `leaseExpiresAt` already past, and `wakeAt` is null or due. The write sets `leaseOwner` to the worker id, `leaseFence` to `nextFence(run.leaseFence)`, and `leaseExpiresAt` to now + 5 minutes.
3. A second `updateMany` moves `leased` + matching owner and fence to `running`.
4. If either update matches 0 rows, this worker lost the claim and returns.
5. Heartbeats renew the lease (`renewRunLease` in `packages/adapters/src/run-lifecycle.ts`). A stale fence cannot commit.

Events are the ordered log the UI applies. `ProductEventType` in `packages/contracts/src/events.ts` includes `thread.message.created`, `thread.ask`, `thread.choice`, `run.started`, `run.waiting_input`, `run.completed`, `run.failed`, `run.cancelled`, `computer.takeover.requested`, `computer.takeover.granted`, `computer.takeover.released`, `routine.fired`, `effect.recorded`, `agent.tool.called`, `agent.tool.completed`. Persistence is `createThreadEvents`. Sequence is per thread, unique `(threadId, seq)`.

Stuck work: `STUCK_WORK_NOTIFY_AFTER_MS` is 4 hours (`packages/core/src/stuck-work.ts`). That is a separate notifier from run dispatch.

## SandboxProvider

Interface: `SandboxProvider` in `packages/adapter-kit/src/interfaces.ts`. Required surface: `describe`, `provision`, `prepare`, `execute`, `connectScreen`, `sendInput`, `observe`, `act`, `listFiles`, `readFile`, `writeFile`, `exportWorkspace`, `importWorkspace`, `snapshot`, `stop`, `destroy`. Optional: `pageBrowser`, `connectTerminal`, `cancelRunWork`, `isRunning`, `isStopped`, `releaseScreen`, `keepAlive`, `billsWhileRunning`.

Selection:

- `resolveSandboxProvider` (`packages/adapters/src/sandbox-provider-env.ts`) reads `SANDBOX_PROVIDER` (default `docker`). A remote kind with no API key becomes `none` so the process can still boot.
- `createSandboxProvider` (`packages/adapters/src/sandbox-factory.ts`) constructs the class. Unknown kinds throw and list `none | docker | e2b | novita | daytona | createos | boat | railway | kubernetes | desktop | fake`.
- `createRunSandbox` (`packages/adapters/src/host-aware-sandbox.ts`) is what API and worker call. `desktop` asserts host commands are allowed and returns `DesktopSandboxProvider`. `docker` with a Prisma client returns `HostAwareSandbox`, which can route to `HostComputerSandbox` when `DeploymentSettings.computerHost === "this-mac"`. `sandboxKindForBot` maps that same host choice onto the `Computer.kind` stored at bot creation (`packages/db/src/repos.ts`).

| Class | File |
| --- | --- |
| `NoneSandboxProvider` | `packages/adapters/src/none-sandbox.ts` |
| `DockerSandboxProvider` | `packages/adapters/src/docker-sandbox.ts` |
| `E2BSandboxProvider` | `packages/adapters/src/e2b-sandbox.ts` |
| `NovitaSandboxProvider` | `packages/adapters/src/novita-sandbox.ts` |
| `DaytonaSandboxProvider` | `packages/adapters/src/daytona-sandbox.ts` |
| `CreateOSSandboxProvider` | `packages/adapters/src/createos-sandbox.ts` |
| `BoatSandboxProvider` | `packages/adapters/src/boat-sandbox.ts` |
| `RailwaySandboxProvider` | `packages/adapters/src/railway-sandbox.ts` |
| `KubernetesSandboxProvider` | `packages/adapters/src/kubernetes-sandbox.ts` |
| `DesktopSandboxProvider` | `packages/adapters/src/desktop-sandbox.ts` |
| `FakeSandboxProvider` | `packages/adapters/src/fake-sandbox.ts` |
| `HostComputerSandbox` | `packages/adapters/src/host-computer-sandbox.ts` |
| `HostAwareSandbox` | `packages/adapters/src/host-aware-sandbox.ts` |
| `RemoteDesktopSandboxProvider` | `packages/adapters/src/remote-desktop-sandbox.ts` |

`E2BSandboxProvider` and `NovitaSandboxProvider` extend `RemoteDesktopSandboxProvider`. Docker command execution goes through the supervisor, not by the API shelling into the container itself. `SANDBOX_PROVIDER=desktop` runs commands on the host (`assertHostCommandsAllowed` in `packages/adapters/src/desktop-sandbox.ts`).

Idle sleep and the billable lifetime cap are `SANDBOX_IDLE_MS` and `COMPUTER_MAX_ACTIVE_MS` (`.env.example`). Providers that bill while running implement `billsWhileRunning`.

## Tool gate and approvals

Entry: `gateToolCall` in `packages/adapters/src/run-tool-gate.ts`.

Policy lives in `packages/core/src/action-approval.ts`:

- `ApprovalMode` is `never` | `auto` | `ask` (also `ApprovalModeSchema` in `packages/contracts/src/domain.ts`).
- `approvalModeFromPreference`: `skipApprovals` → `never`; `enabled` → `auto`; otherwise `ask`.
- `planActionGate` decides block, ask, or run. `never` still refuses work the owner did not start, or work after outside content entered the run (`steerable`). A block refuses in every mode.
- `toolRequiresApproval` / `toolRequiresExplicitApproval` classify tools. The user's own computer always asks first (`packages/adapters/src/run-tools-user-computer.ts`).

Effects: `claimIntendedEffect` / `claimApprovedEffect` in `packages/adapters/src/approval-effect.ts`, recorded as `ExternalEffect` with statuses `intended`, `completed`, `failed`, `ambiguous`, `reconciled` (`EffectStatus`). The idempotency key is `approvalEffectKey` (`packages/core/src/approval-effect-key.ts`, exported from `@rakazo/core/node/approval-effect-key`).

When the gate pauses, the run goes to `waiting_input` via `pauseForApproval` (`packages/adapters/src/run-context.ts`) and the UI gets an ask card (`buildApprovalAskBlock` in `packages/adapters/src/approval-ask.ts`). Resume is another `run.continue` after the person answers. Auto review, when configured, calls the approval model (`packages/adapters/src/auto-review.ts`, env `RAKAZO_AUTO_REVIEW_*` in `.env.example`). Rules are `ActionApprovalRule` (per space member) and `UserActionApprovalRule` (per user).

Computer screen takeover is a different wait: `waiting_takeover`, events `computer.takeover.*`, control fields on `Computer`.

## Routines

`model Routine`: `crons` (string array), `timezone` default `UTC`, `active`, `nextRunAt`, `watch` / `watchState` JSON, optional `threadId`, optional model override, `webhookEnabled`, `githubEnabled`, `messageProvider`.

Scheduling writes `nextRunAt` and enqueues `routineWakeupJob` (`packages/adapter-kit/src/background-jobs.ts`). The job name is `routine.wakeup` with payload `{ routineId, scheduledFor }` and `replaceKey` `routine:${routineId}`, so one pending wake exists per routine. Graphile (or the memory driver) delivers it. The handler is `createBackgroundJobHandlers` key `"routine.wakeup"` (`packages/adapters/src/background-job-handlers.ts`), which calls `wakeRoutine` (`packages/adapters/src/run-routines.ts`).

`wakeRoutine` no-ops unless the routine is still active and `nextRunAt` still equals `scheduledFor`. It then creates a `Run` with `trigger` `routine`. Timer catch-up and coalescing are described in `docs/run-execution.md` and implemented in `packages/adapters/src/routine-coalescing.ts`. A failed routine run schedules `routine.retry` (`routineRetryJob`), keyed by the failed run id. `Run.retryOfRunId` being unique means one retry.

Watch routines (file/URL/credential change) advance `nextRunAt` in `packages/adapters/src/routine-watch.ts` and enqueue the same wakeup job. Message-triggered routines are woken from the API inbound path (`wakeMessageRoutines` in `apps/api/src/messaging-inbound.ts`), not from the worker poll.

Index for the due scan: `@@index([active, nextRunAt])` on `Routine`.

## Vault

RPC: `vault.list`, `vault.put`, `vault.reveal`, `vault.remove` in `packages/contracts/src/rpc.ts`. Handlers are the `vault` key inside `botsRoutes` (`apps/api/src/routes/bots.ts`).

- `list` → `listBotSecretMetadata` (`packages/adapters/src/bot-secrets.ts`).
- `put` → local `saveVaultCredential`, which stores ciphertext via `prepareBotSecret` / `storeBotSecret`.
- `reveal` → `requireIdentityConfirmation` (`apps/api/src/identity-confirmation.ts`) then `revealBotSecret`. It records security event `credential.revealed`.
- `remove` → `forgetBotSecret`.

`vaultScope` chooses the account vault (`spaceId` null) or the space override. Bots read whichever vault the space uses. `botSecrets.*` RPC methods are the same vault, checked against a bot the actor owns; they are not a second secret table write.

Account-wide named secrets for tools are `agentSecrets` (`AgentSecret` + `Secret`), separate from the login vault.

## Auth

`createAuth` in `packages/auth/src/index.ts` builds `betterAuth`:

- `appName` `"Rakazo"`, `secret` from `BETTER_AUTH_SECRET`, `baseURL` `BETTER_AUTH_URL`.
- Database: `prismaAdapter` on the same Postgres database. User/session/account/verification/passkey models are the Better Auth tables in `schema.prisma` (`User` map `user`, `Session`, `Account`, `Verification`, `Passkey`).
- Email+password unless `passwordAuth === false` (then OIDC is required).
- Plugins: `signedBearer`, `expo()`, `accountSecurity`, `identityConfirmation`, optional OIDC discovery, optional `emailOTP`, optional `breachedPasswordCheck`, optional `passkey`.
- Trusted origins include the web origin and `rakazo://`.
- Rate limits: `authRateLimitOptions` in the same file.
- Session create hook: if the user has no `SpaceMember`, and signup policy allows the email, call `bootstrapUserSpace`. Policy is `signupPolicyFromEnv` (`packages/core/src/signup-policy.ts`) from `SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST`, also mirrored into `DeploymentSettings`.
- OAuth tokens are encrypted (`account.encryptOAuthTokens: true`). Reset-password and delete-account verification identifiers are stored hashed.

The HTTP mount is `app.on(["GET", "POST"], "/api/auth/*", auth.handler)` in `apps/api/src/app.ts`. Capabilities are `GET /api/auth/capabilities`.

## i18n status

Two catalogs, not one.

Web (`@rakazo/web`) uses Lingui. Locales in `apps/web/lingui.config.ts` and `UI_LOCALES` in `apps/web/src/lib/ui-locale.ts`:

`en`, `de`, `ko`, `tr`, `hi`, `pt-BR`, `zh-CN`, `zh-TW`, `es`, `ru`, `fr`, `he`, `nl`, `ja`.

Source locale is `en`. Catalogs are `apps/web/src/locales/<locale>/messages.po`. Runtime load/activate is `apps/web/src/lib/i18n.ts`, mounted by `apps/web/src/components/I18nBootstrap.tsx`. Saved choice key is `rakazo.uiLocale`. Default can be `VITE_DEFAULT_UI_LOCALE`. Scripts: `intl:extract`, `intl:compile` in `apps/web/package.json`.

Mobile does not use Lingui. `UI_LOCALES` in `apps/mobile/lib/ui-locale.ts` is `en`, `zh-CN`, `zh-TW`, `ru`, `de`, `nl`, `ja`. English is the source string. Other catalogs are `apps/mobile/lib/locales/zh.ts`, `zh-TW.ts`, `ru.ts`, `de.ts`, `nl.ts`, `ja.ts`, applied by `t()` in `apps/mobile/lib/i18n.ts`. Storage key is also `rakazo.uiLocale` (SecureStore). Default env is `EXPO_PUBLIC_DEFAULT_UI_LOCALE`. Resolution order is saved choice, then that env, then device language, then `en` (`resolveUiLocale`). Shared matching is `matchUiLocale` in `packages/core/src/ui-locale.ts`.

`.env.example` comments list a shorter set than the code (web omits several locales; mobile comment still says Account → Language offers English and Simplified Chinese). Trust `UI_LOCALES`, not that comment.

`apps/www` has its own per-locale pages (`apps/www/src/pages/de/index.astro` and siblings). It does not read the app catalogs.

Adding a language means touching the catalog for that surface only. It does not require a schema change. Web and mobile lists are intentionally different; a locale added to one does not appear on the other.

## UI tokens and theming

One semantic palette: `ColorTokens` and `lightTokens` in `packages/ui-tokens/src/index.ts`. `renderTokensCss()` writes `packages/ui-tokens/src/tokens.css` via `pnpm --filter @rakazo/ui-tokens generate` (`packages/ui-tokens/src/generate-css.ts`). Package export `./css` points at that file.

Web and Electron consume the CSS variables through `packages/ui-web/src/styles.css` and Tailwind. Components are vendored shadcn on Base UI under `packages/ui-web` (`packages/ui-web/components.json`). Do not add a third-party shadcn registry. AI moments (loading, shimmer) live in `apps/web/src/components/ai/primitives.tsx`.

Mobile reads the same tokens in JS: `tokensForAppearance` from `@rakazo/ui-tokens`, applied in `apps/mobile/lib/appearance.ts`. System chrome stays native (`PlatformColor` / Expo UI), not a port of the web CSS.

Appearance preference values are `system` | `light` | `dark` (`APPEARANCE_PREFERENCES`). Storage key `rakazo.uiAppearance` (`UI_APPEARANCE_STORAGE_KEY`).

Bot identity color is not a semantic token. New bots pick from `BOT_COLORS` in `packages/contracts/src/ids.ts` (fixed hex list). `chooseBotAvatar` in `packages/db/src/bot-avatar-choice.ts` applies that list during `Repos.createBot` (`packages/db/src/repos.ts`). Changing the app chrome does not recolor existing bots. Changing `BOT_COLORS` only affects bots created afterwards.

Brand export script: `packages/ui-tokens/package.json` script `export:brand`.

A look-and-feel change that should hit every surface edits `packages/ui-tokens/src/index.ts`, regenerates `tokens.css`, and checks web (`packages/ui-web`), Electron (it hosts the web bundle), and `apps/mobile/lib/appearance.ts`. Marketing pages in `apps/www` use `@rakazo/ui-web` but are a separate build. Copy is per surface (Lingui vs mobile `t()` vs Astro). Desktop `productName` and icons are `apps/desktop/package.json` `build` plus `packages/ui-tokens/assets`.

## Config and environment

Canonical names and comments: `.env.example`. Do not add a provider-specific variable when the generic connection settings already express it (root `AGENTS.md`).

Groups an agent actually branches on:

| Concern | Variables |
| --- | --- |
| Database | `DATABASE_URL` (runtime, `rakazo_app`), `DATABASE_MIGRATION_URL` (owner), `POSTGRES_*`, `DB_POOL_MAX` |
| Auth | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_ORIGIN`, `SIGNUPS_ENABLED`, `SIGNUP_ALLOWLIST`, `AUTH_BREACHED_PASSWORD_CHECK_ENABLED`, passkey app ids |
| Encryption | `ENCRYPTION_KEY`, `ENCRYPTION_MASTER_KEYS`, `MASTER_KEY_PROVIDER`, `CONTENT_ENCRYPTION` |
| Secrets backend | `SECRET_STORE` (`encrypted` or Infisical vars) |
| Sandbox | `SANDBOX_PROVIDER`, `SANDBOX_SUPERVISOR_URL`, `SANDBOX_SUPERVISOR_TOKEN`, `SCREEN_PROXY_SECRET`, provider keys (`E2B_API_KEY`, `NOVITA_API_KEY`, `DAYTONA_*`, `CREATEOS_SANDBOX_*`, `BOAT_API_KEY`, `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID`), limits `SANDBOX_IDLE_MS`, `COMPUTER_MAX_ACTIVE_MS`, `SANDBOX_COMPUTER_EGRESS` |
| Model | `AGENT_RUNTIME`, `PI_DEFAULT_PROVIDER`, `PI_DEFAULT_MODEL`, provider keys, `RAKAZO_LOCAL_MODELS` |
| Jobs | `WAKEUP_DRIVER` (`graphile` or `memory`), `GRAPHILE_WORKER_CONCURRENCY` |
| Optional products | `TICKET_BOARD_ENABLED`, `PHONE_CALLS_ENABLED`, `USER_DEVICES_ENABLED`, `COMPOSIO_API_KEY`, `PIPEDREAM_*`, messaging tokens, `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`, `EMAIL_PROVIDER` / `SMTP_URL`, `EXPO_ACCESS_TOKEN`, `PAYMENT_WALLET_PROVIDER`, `CLOUD_AGENT_PROVIDER` |
| Locales | `VITE_DEFAULT_UI_LOCALE`, `EXPO_PUBLIC_DEFAULT_UI_LOCALE` |

API reads its own subset in `apps/api/src/env.ts` (`loadEnv`). Worker reads `process.env` directly in `apps/worker/src/index.ts`. If a flag must be true on both (ticket board, phone calls, user devices), set it on both processes.

Object storage (`OBJECT_STORAGE_*`) replaces local `DATA_DIR` for computer homes and artifacts when the bucket is set.

## Deployment files

| File | What it runs |
| --- | --- |
| `infra/compose/docker-compose.yml` | Dev/source stack: `postgres`, `supervisor`, `computer` image build, `data-init`, `migrate`, `api`, `worker`, `web`. |
| `infra/compose/docker-compose.prod.yml` | Production overlay. |
| `infra/compose/docker-compose.prod.docker.yml` | Production with local Docker sandboxes. |
| `infra/compose/docker-compose.images.yml` | Published images (also copied into the desktop app). |
| `infra/compose/docker-compose.postgres-host.yml` | Publishes Postgres for host-side `pnpm dev`. |
| `infra/compose/Caddyfile.prod` | TLS reverse proxy. |
| `infra/compose/install-images.sh` | Bootstrap without a git checkout. |
| `infra/compose/restrict-computer-egress.sh` | Host firewall for `SANDBOX_COMPUTER_EGRESS=restricted`. |
| `infra/sandboxes/computer/Dockerfile` | Guest image (`pnpm sandbox:build` in root `package.json`). |
| `infra/sandboxes/supervisor/src/index.ts` | Supervisor process. |
| `infra/updater/src/index.ts` | Optional Compose updater sidecar (`RAKAZO_UPDATER_TOKEN`). |
| `infra/railway/Dockerfile`, `infra/railway/start.sh`, `infra/railway/README.md` | Railway template. |
| `infra/systemd/` | Backup and host-check units. Not the product process model. |

Production deploys run the previous and new API together for a few seconds after migrations (`AGENTS.md`). Migrations must add columns and tables first. Drop or rename only in a later deploy. The RLS `*_previous_release` policies and the leftover `bot_secrets` table are examples of that rule.

## Do not break

1. `threads_owner_chk`: a thread has exactly one of `botId`, `groupId`, `externalConversationId`. Each is unique. Creating a second thread for a bot violates `Thread.botId @unique`.
2. Run transitions in `canTransition`. Do not write a status the table does not allow. `completed` and `cancelled` do not restart. `failed` may return to `queued` once.
3. Run claims are compare-and-set on status, `leaseFence`, and `leaseExpiresAt` (`continueRun`). A worker that lost the fence must not write messages or effects. Lease length in that claim is 5 minutes and must be renewed.
4. `NOTIFY` / `runs:ready` is a latency hint. The 5 second scan is the recovery path. Do not require the notification for correctness.
5. Agent runs are not Graphile jobs. `RunJobPublisher` only forwards non-`run.continue` work to Graphile. Do not occupy `GRAPHILE_WORKER_CONCURRENCY` with model streams.
6. RLS: product requests run as `runAsTenant`. Cross-tenant work calls `runAsSystem` with a reason. A connection with no context must keep seeing zero protected rows. Do not point `DATABASE_URL` at the migration owner.
7. During a rolling deploy, `app.rls_version` `< 2` still matches `*_previous_release`. Do not drop those policies, or `bot_secrets`, while an older release is running.
8. `ExternalEffect.idempotencyKey` and `Run.retryOfRunId` uniqueness. Re-running a tool or a routine retry must hit the same row, not insert another.
9. `Message` and `Event` sequence uniqueness per thread. Allocate with `nextMessageSeq` / `nextEventSeq`.
10. Vault uniqueness is `NULLS NOT DISTINCT` on `(userId, spaceId, name)`. A Prisma-only unique will not treat two null `spaceId` values as the same account-vault name.
11. API owns inbound messaging long-poll. The worker must not call Telegram `getUpdates` (`apps/worker/src/index.ts` comment). Webhooks arrive at `/api/v1/messaging/webhook/<provider>`.
12. `SANDBOX_PROVIDER=desktop` and `HostComputerSandbox` execute on a machine the user owns. Keep `assertHostCommandsAllowed` in front of that path.
13. API and worker share `ENCRYPTION_KEY` and the secret backend. A mismatch silently fails decrypt.
14. Personal space id equals its organization id (`bootstrapUserSpace`). Do not assume a second id space.
15. `ProductEventType` `"heartbeat"` is not persisted. Do not store it or advance `nextEventSeq` for it.
16. Package names and the auth app name stay Rakazo. The mobile scheme is `rakazo://`. The realtime channel is `rakazo_events`. The DB role is `rakazo_app`. Renaming those is a migration, not a label change.

## Safe extension points

Add an implementation behind the existing interface. Wire it in the API and worker composition roots (`apps/api/src/app.ts`, `apps/worker/src/index.ts`). Keep the vendor SDK inside `packages/adapters`.

| Extension | Where |
| --- | --- |
| Computer provider | New class implementing `SandboxProvider`. Register it in `createSandboxProvider` and `resolveSandboxProvider`. Add a conformance test next to the other sandbox tests. |
| Tool source | `ConnectorProvider` (`packages/adapter-kit/src/interfaces.ts`). Built-ins: `McpConnector`, `ComposioConnector`, `PipedreamConnector`, `InstalledConnectorProvider`. |
| Chat channel | `MessagingSurface` / platform descriptors from `messagingPlatformsFromEnv`. A platform mounts only when its env set is complete (`.env.example` messaging block). Inbound stays on the API. |
| Language | Web: add to `apps/web/lingui.config.ts`, `apps/web/src/lib/ui-locale.ts`, and a `messages.po`. Mobile: add to `apps/mobile/lib/ui-locale.ts` and `apps/mobile/lib/locales/`, and register it in `apps/mobile/lib/i18n.ts`. www: a page under `apps/www/src/pages/`. |
| Payments | `BillingProvider` implementation. Stripe is `StripeBillingProvider`, enabled only when both Stripe secrets are set. Wallet purchases are `PAYMENT_WALLET_PROVIDER` (`createPaymentWalletProvider`). Absent billing hides the paywall (`RouterDeps.billing`). |
| Email | `TransactionalEmailProvider`. `EMAIL_PROVIDER` `resend`, `smtp`, or `none`. `EMAIL_EMULATOR` is local only. |
| Memory | `MemoryStore` (`MarkdownMemoryStore` in `packages/memory/src/index.ts`) or `SpaceMemoryProviderResolver` for Supermemory (`SUPERMEMORY_API_KEY`). |
| Speech | `UserVoiceCredential` plus the voice provider adapter. No new env var per model if the credential record can store it. |
| Background work that is not a chat turn | New name in `payloadSchemas` (`packages/adapter-kit/src/background-jobs.ts`) and a handler in `createBackgroundJobHandlers`. Do not put the chat turn itself there. |
| Look and feel | `packages/ui-tokens/src/index.ts` only, then regenerate CSS. |
| Deployment-only integrations catalog | `INTEGRATIONS_CATALOG_URL`. |

Not extension points: the thread constraint, the run/event sequence model, the lease/fence claim, RLS session variables, and Better Auth session → `Actor` → `runAsTenant`. Those are the core.

## Glossary

| Name in this repo | Meaning |
| --- | --- |
| Rakazo | The product name compiled into packages, Better Auth `appName`, Electron `productName`, DB role `rakazo_app`, channel `rakazo_events`, and the `rakazo://` app scheme. Leave the identifiers. |
| Bot | A persistent teammate: instructions, one thread, a computer binding, memory, routines. `model Bot`. |
| Space | The tenant workspace. Almost every product row has `spaceId`. |
| Organization | Membership and billing container above spaces. Personal signup creates one. |
| Actor | `{ userId, spaceId, email }` for the request. |
| Thread | The single ordered conversation for one bot, one group, or one external conversation. |
| Message | A chat row (`user`, `bot`, or `system`) with a per-thread `seq`. |
| Event | A product fact the UI applies, also per-thread `seq`. Not the same row as a message. |
| Run | One piece of agent work. Has a status, a trigger, and a lease. |
| Attempt | One execution try of a run (`model Attempt`). |
| Steering | A user message that arrives while a turn is in progress (`model SteeringMessage`). Non-conversational runs do not absorb it. |
| Task | The prompt record a run hangs off (`model Task`). |
| Routine | A schedule, webhook, or watch that creates runs. |
| Computer | The sandbox record (team or dedicated), including screen and execution leases. |
| ComputerRun | A billed stretch of provider uptime. Survives computer deletion. |
| Vault / `VaultCredential` | The member's saved logins. |
| `BotSecret` | Legacy per-bot credential rows kept for rolling upgrade. |
| `AgentSecret` | A named space secret exposed to tools. |
| Effect / `ExternalEffect` | A side effect the gate recorded, idempotent by `idempotencyKey`. |
| Lease / fence | Short ownership of a run or a computer. The fence is a counter a stale worker cannot satisfy. |
| Sandbox | A `SandboxProvider` implementation behind a `Computer`. |
| Supervisor | The local Docker control process (`@rakazo/sandbox-supervisor`). |
| Graphile | `graphile-worker` queue for maintenance and routine wakes. Not the chat-turn queue. |
| Pi | The default agent runtime (`PiAgentRuntime`, package `@earendil-works/pi-agent-core`). |
| oRPC | The typed RPC layer. Contract in `@rakazo/contracts`, server `RPCHandler`, web client in `apps/web/src/lib/rpc.ts`. |
| Better Auth | Session and credential library composed in `@rakazo/auth`. |
| RLS | Postgres row-level security driven by `app.space_id` / `app.user_id` / `app.rls_bypass` / `app.rls_version`. |
