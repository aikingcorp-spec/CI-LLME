import { homedir } from "node:os";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SecretStore,
  TerminalRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  draftRecordingsOfLease,
  isSpaceOrganizationOwner,
  machineOwnerUserId,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork, providerKeepsHome } from "./computer-idle.js";
import { computerProviderDescriptor } from "./computer-provider-registry.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import {
  ConfiguredSandbox,
  loadComputerOwnerSettings,
  loadComputerProviderSelection,
} from "./configured-sandbox.js";
import { managedLoopbackHost } from "./host-computer-protocol.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import {
  assertHostCommandsAllowed,
  DesktopSandboxProvider,
} from "./providers/computer/desktop/desktop-sandbox.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  if (envKind === "docker" && computerHost === "this-mac") return "desktop";
  return envKind;
}

export async function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & {
    prisma?: PrismaClient;
    secrets?: Pick<SecretStore, "load" | "onChange">;
  },
): Promise<SandboxProvider> {
  const base = await createBaseRunSandbox(kind, opts);
  // With the database at hand, Settings can send computers elsewhere: an admin's choice for
  // everyone, or an account's own provider.
  if (!opts.prisma || !opts.secrets || kind === "desktop" || kind === "fake") return base;
  const { prisma, secrets } = opts;
  const configured = new ConfiguredSandbox(
    base,
    () => loadComputerProviderSelection(prisma, secrets, true),
    {
      onSecretChange: secrets.onChange?.bind(secrets),
      loadOwn: (homeKey) => loadComputerOwnerSettings(prisma, secrets, homeKey, true),
      createProvider: (settings) =>
        createBaseRunSandbox(settings.provider, {
          ...opts,
          ...computerProviderDescriptor(settings.provider).verify(settings.values),
        }),
    },
  );
  // Startup never waits on the secret store or a saved provider: routing rereads them on first use.
  await configured
    .refresh()
    .catch((error) => getLogger().warn("computer_provider.load_failed", { error }));
  return configured;
}

async function createBaseRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient },
): Promise<SandboxProvider> {
  if (kind === "desktop") {
    assertHostCommandsAllowed();
    return new DesktopSandboxProvider({
      root: opts.dataDir,
      hostRoots: [homedir()],
      enablePageBrowser: true,
    });
  }
  const prisma = opts.prisma;
  const primary = await createSandboxProvider(kind, {
    ...opts,
    referenceInUse: prisma
      ? async (computer) =>
          (await runAsSystem("check whether another computer shares a provider resource", () =>
            prisma.computer.count({
              where: {
                kind: computer.kind,
                providerRef: computer.providerRef,
                homeKey: { not: computer.botId },
                // One still saving its workspace needs the desktop until it finishes.
                state: { in: ["booting", "running", "suspending"] },
              },
            }),
          )) > 0
      : opts.referenceInUse,
    onUnsafeStop: opts.prisma
      ? async (providerRef) => {
          // Quarantine ends any person's control; a recording made under it ends with it.
          const held = await opts.prisma!.computer.findMany({
            where: { kind, providerRef, controlLeaseId: { not: null } },
            select: { spaceId: true, controlLeaseId: true },
          });
          const quarantined = await opts.prisma!.computer.updateMany({
            where: { kind, providerRef },
            data: {
              state: "quarantined",
              screenUrl: null,
              screenGeneration: { increment: 1 },
              controlFence: { increment: 1 },
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
            },
          });
          if (quarantined.count === 0)
            throw new Error("Computer recovery requirement could not be recorded");
          for (const { spaceId, controlLeaseId } of held) {
            await draftRecordingsOfLease(opts.prisma!, { spaceId, leaseId: controlLeaseId! });
          }
        }
      : opts.onUnsafeStop,
  });
  if (!prisma) return primary;
  const nativeBridge =
    kind === "none"
      ? managedLoopbackHost({ url: opts.hostComputerUrl, token: opts.hostComputerToken })
      : undefined;
  if (kind !== "docker" && !nativeBridge) return primary;
  return new HostAwareSandbox(
    primary,
    new HostComputerSandbox(
      nativeBridge?.url ?? opts.hostComputerUrl ?? "",
      nativeBridge?.token ?? opts.hostComputerToken ?? "",
      { enablePageBrowser: Boolean(nativeBridge) },
    ),
    nativeBridge ? nativeHostEnabled(prisma) : dockerHostEnabled(prisma),
  );
}

function dockerHostEnabled(prisma: PrismaClient) {
  return async (context?: AdapterContext) => {
    // The Host machine and its credentials stay with the organization owner. A guest, member,
    // or admin keeps the isolated computer even when the deployment offers this machine.
    if (context && !(await isSpaceOrganizationOwner(prisma, context))) return false;
    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    return settings?.computerHost === "this-mac";
  };
}

function nativeHostEnabled(prisma: PrismaClient) {
  return async (context?: AdapterContext) => {
    // Owning a personal Space is not enough. The host belongs to the install's first verified
    // account, and only after that account has selected this computer.
    if (!context || !(await isSpaceOrganizationOwner(prisma, context))) return false;
    const ownerId = await machineOwnerUserId(prisma);
    if (!ownerId || ownerId !== context.userId) return false;
    const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    return settings?.computerHost === "this-mac";
  };
}

export class HostAwareSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: (context?: AdapterContext) => Promise<boolean>,
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = (computer, request, context) => {
        const provider = this.route(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  ownsReference(computer: Pick<ComputerRef, "kind" | "providerRef">) {
    return this.route(computer).ownsReference?.(computer) ?? true;
  }

  describe() {
    return this.isolated.describe();
  }

  private route(computer: Pick<ComputerRef, "kind">) {
    return computer.kind === "desktop" ? this.host : this.isolated;
  }

  private async assertLocalAccess(computer: Pick<ComputerRef, "kind">, context?: AdapterContext) {
    if (computer.kind === "desktop" && !(await this.hostEnabled(context))) {
      throw new Error(
        "This computer is reserved for the host owner; guest computer access is disabled without Docker.",
      );
    }
  }

  private async open(computer: Pick<ComputerRef, "kind">, context?: AdapterContext) {
    await this.assertLocalAccess(computer, context);
    return this.route(computer);
  }

  async provisionKind() {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    return provider.describe().id;
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ) {
    const provider = (await this.hostEnabled(context)) ? this.host : this.isolated;
    const providerKind = provider.describe().id;
    return provider.provision(
      {
        ...request,
        providerRef: request.providerKind === providerKind ? request.providerRef : undefined,
      },
      context,
    );
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const provider = (await this.hostEnabled(context)) ? this.host : this.isolated;
    if (provider.describe().id !== computer.kind) return false;
    return provider.isRunning?.(computer, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind === "desktop" && !(await this.hostEnabled(context))) return false;
    return this.route(computer).isStopped?.(computer, context) ?? false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    const provider = await this.open(computer, context);
    return provider.environment?.(computer, context);
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    const provider = await this.open(computer, context);
    return provider.prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* (await this.open(computer, context)).execute(computer, request, context);
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return manageComputerWorkspaceDirectories(
      await this.open(computer, context),
      computer,
      request,
      context,
    );
  }

  async cancelRunWork(
    computer: ComputerRef,
    computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    return cancelComputerRunWork(
      await this.open(computer, context),
      computer,
      computerId,
      runId,
      context,
    );
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return (await this.open(computer, context)).connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = await this.open(computer, context);
    if (!provider.connectTerminal) {
      throw new Error("terminal is unavailable on this computer");
    }
    return provider.connectTerminal(computer, request, context);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return (await this.open(computer, context)).sendInput(computer, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return (await this.open(computer, context)).observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return (await this.open(computer, context)).act(computer, request, context);
  }

  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.open(computer, context)).listFiles(computer, path, context);
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return (await this.open(computer, context)).readFile(computer, path, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return (await this.open(computer, context)).writeFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ) {
    yield* (await this.open(computer, context)).exportWorkspace(computer, context, limits);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return (await this.open(computer, context)).importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.open(computer, context)).snapshot(computer, context);
  }

  billsWhileRunning(computer: Pick<ComputerRef, "kind">): boolean {
    return this.route(computer).billsWhileRunning?.(computer) ?? false;
  }

  keepsHome(computer: ComputerRef) {
    return providerKeepsHome(this.route(computer), computer);
  }

  keepAlive(computer: ComputerRef) {
    return this.route(computer).keepAlive?.(computer) ?? Promise.resolve();
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    if (computer.kind === "desktop" && !(await this.hostEnabled(context))) return;
    return this.route(computer).releaseScreen?.(computer, context) ?? Promise.resolve();
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    if (computer.kind === "desktop" && !(await this.hostEnabled(context))) return;
    return (
      this.route(computer).setScreenControl?.(computer, interactive, context, controlToken) ??
      Promise.resolve()
    );
  }

  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ) {
    return (await this.open(computer, context)).stop(computer, context, options);
  }

  async destroy(computer: ComputerRef, context: AdapterContext) {
    return (await this.open(computer, context)).destroy(computer, context);
  }
}
