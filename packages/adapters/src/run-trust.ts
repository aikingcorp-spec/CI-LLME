import type { MessageBlock } from "@rakazo/contracts";
import type { ActionApprovalRule } from "@rakazo/core";
import {
  BACKGROUND_HELPER_TRIGGER,
  connectorKindFromToolName,
  HELPER_RESULT_TRIGGER,
  inboundRoutinePrompts,
  SITE_SENDING_TOOLS,
  siteAlwaysAllowed,
} from "@rakazo/core";
import { sitesInText, urlSite } from "@rakazo/core/egress";
import {
  findAutoReviewPreference,
  listApprovalRules,
  storedBatchActions,
  storedMessageBlocks,
} from "@rakazo/db";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { EffectiveModelRole } from "./model-roles.js";
import { effectiveModelRole } from "./model-roles.js";
import { routineTaskInstructions } from "./routine-watch.js";
import { CATALOG_APPROVAL_TOOL, PASSED_EFFECT_STATUSES } from "./run-effects.js";
import { loadRunOrigin } from "./run-origin.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./run-tool-selection.js";

/**
 * The connection a connector call reaches, for read trust. Installed APIs are told apart by their
 * resource, since their tool names share a prefix; other connectors by their tool-name kind.
 */
function connectorTrustKey(
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
): string {
  return route?.connectorId && route.resourceId
    ? `resource:${route.connectorId}:${route.resourceId}`
    : `kind:${connectorKind}`;
}

/**
 * Read trust for each app a batch reaches, since every batch shares one tool: a Gmail batch must
 * not make a later Slack read trusted, nor one server's batch a batch on another server. An action
 * outside every connected app keys by its own name.
 */
export function connectorTrustKeys(
  batchActions: readonly string[] | undefined,
  route: { connectorId?: string; resourceId?: string } | undefined,
  connectorKind: string,
  providers: string[],
): string[] {
  const connection = connectorTrustKey(route, connectorKind);
  if (!batchActions?.length) return [connection];
  const apps = providers.map((provider) => provider.toLowerCase());
  return batchActions.map((name) => {
    const action = name.toLowerCase();
    const app = apps
      .filter((kind) => action === kind || action.startsWith(`${kind}_`))
      .sort((left, right) => right.length - left.length)[0];
    return `${connection}:${app ?? action}`;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownerMentionsLabel(ownerWords: string, rawLabel: string | undefined): boolean {
  if (!ownerWords || !rawLabel) return false;
  const label = rawLabel.trim();
  if (label.length < 3) return false;
  const tokens = label
    .split(/[\s_-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const spaced = tokens.map(escapeRegExp).join("[\\s_-]+");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${spaced})(?![\\p{L}\\p{N}_])`, "iu");
  return pattern.test(ownerWords);
}

/**
 * Connected apps and MCP/API resources explicitly named in the owner's own prompt or routine
 * instructions are already intended for this run, just like owner-named sites in loadTrustedSites.
 * Unmentioned connectors stay untrusted once outside content enters the run.
 */
export function ownerNamedConnectorTrustKeys(
  ownerWords: string,
  connectedPlugins: readonly { provider: string; connectorId?: string; displayName?: string }[],
  connectorRoutes: readonly {
    connectorId?: string;
    resourceId?: string;
    catalogGroup?: string;
  }[] = [],
): Set<string> {
  const trusted = new Set<string>();
  if (!ownerWords.trim()) return trusted;
  for (const plugin of connectedPlugins) {
    const provider = plugin.provider.trim().toLowerCase();
    if (!provider) continue;
    const matched =
      ownerMentionsLabel(ownerWords, plugin.displayName) ||
      ownerMentionsLabel(ownerWords, provider);
    if (!matched) continue;
    trusted.add(`kind:${provider}`);
    const connectorId = plugin.connectorId?.trim().toLowerCase();
    if (connectorId) trusted.add(`kind:${connectorId}:${provider}`);
  }
  for (const route of connectorRoutes) {
    if (!route.connectorId || !route.resourceId || !route.catalogGroup) continue;
    const baseName = route.catalogGroup.split(" (")[0]?.trim();
    if (ownerMentionsLabel(ownerWords, baseName)) {
      trusted.add(`resource:${route.connectorId}:${route.resourceId}`);
    }
  }
  return trusted;
}

/** Approval and trust lookups a run's tool calls share, each loaded at most once. */
export function createRunTrustLoaders(
  deps: ExecutorDeps,
  input: {
    run: { userId: string; spaceId: string; trigger: string; delegatedFromRunId?: string | null };
    runId: string;
    botId: string;
    taskPrompt: string;
    ownerStartedRun: boolean;
    messagingChannelRun: boolean;
    sourceMessage: { id: string; role: string; blocks: unknown } | null;
    /** The owner's own chat-app message that started a messaging run; absent for anyone else. */
    ownerChatMessageBlocks?: MessageBlock[];
    connectedPlugins: readonly { provider: string; connectorId?: string; displayName?: string }[];
    connectorRoutes?: readonly {
      connectorId?: string;
      resourceId?: string;
      catalogGroup?: string;
    }[];
  },
) {
  const {
    run,
    runId,
    botId,
    taskPrompt,
    ownerStartedRun,
    messagingChannelRun,
    sourceMessage,
    ownerChatMessageBlocks,
    connectedPlugins,
    connectorRoutes,
  } = input;
  let approvalRulesPromise: Promise<ActionApprovalRule[]> | undefined;
  const loadApprovalRules = () => {
    approvalRulesPromise ??= listApprovalRules(deps.prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
    }).then((rules) => rules as ActionApprovalRule[]);
    return approvalRulesPromise;
  };
  let approvalModelPromise: Promise<EffectiveModelRole> | undefined;
  const loadApprovalModel = () =>
    (approvalModelPromise ??= effectiveModelRole(
      deps.prisma,
      { userId: run.userId, spaceId: run.spaceId },
      "approval",
      {},
    ));
  let autoReviewPreferencePromise:
    | Promise<{ enabled: boolean; skipApprovals: boolean }>
    | undefined;
  const loadAutoReviewPreference = () => {
    autoReviewPreferencePromise ??= findAutoReviewPreference(deps.prisma, {
      userId: run.userId,
      spaceId: run.spaceId,
    }).then((row) => ({
      enabled: row?.enabled ?? true,
      skipApprovals: row?.skipApprovals ?? false,
    }));
    return autoReviewPreferencePromise;
  };
  // The owner's own words for this run: the message they sent (in VNBot or their own chat app),
  // or the instructions of the routine that started it. Never a bot, channel or webhook message,
  // or a tool result. These name the sites a run is given, and are all Auto Review sees of a new
  // site's run and of a memory save after outside content.
  let ownerWordsPromise: Promise<string> | undefined;
  const loadOwnerWords = () => {
    ownerWordsPromise ??= (async () => {
      if (run.trigger === BACKGROUND_HELPER_TRIGGER || run.trigger === HELPER_RESULT_TRIGGER) {
        // Delegation inherits privacy; outside speakers cannot authorize owner actions.
        if (messagingChannelRun) return "";
        const origin = await loadRunOrigin(deps.prisma, {
          ...run,
          id: runId,
          botId,
          delegatedFromRunId: run.delegatedFromRunId ?? null,
        });
        const message = origin?.sourceMessage;
        if (
          message?.role !== "user" ||
          message.authorUserId !== run.userId ||
          message.threadId !== origin?.threadId
        )
          return "";
        return storedMessageBlocks(message)
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join("\n");
      }
      // The executor passes chat-app blocks only for the owner's own message.
      const ownerBlocks =
        ownerStartedRun && !messagingChannelRun && sourceMessage?.role === "user"
          ? storedMessageBlocks(sourceMessage)
          : run.trigger === "messaging"
            ? ownerChatMessageBlocks
            : undefined;
      if (ownerBlocks) {
        return ownerBlocks
          .flatMap((block) => (block.kind === "text" ? [block.text] : []))
          .join("\n");
      }
      // Saved when the routine fired, so a later edit cannot change what this run judges.
      if (run.trigger === "routine") return routineTaskInstructions(taskPrompt);
      if (run.trigger === "webhook") {
        const routines = await deps.prisma.routine.findMany({
          where: { botId: botId, spaceId: run.spaceId, userId: run.userId },
          select: { name: true, prompt: true },
        });
        return inboundRoutinePrompts(taskPrompt, routines).join("\n\n");
      }
      return "";
    })();
    return ownerWordsPromise;
  };
  let trustedSitesPromise: Promise<Set<string>> | undefined;
  const loadTrustedSites = () => {
    trustedSitesPromise ??= deps.prisma.externalEffect
      .findMany({
        where: {
          runId,
          kind: { in: [...SITE_SENDING_TOOLS] },
          status: { in: PASSED_EFFECT_STATUSES },
        },
        select: { request: true },
      })
      .then(async (rows) => {
        const sites = sitesInText(await loadOwnerWords());
        for (const row of rows) {
          const url = (row.request as { url?: unknown } | null)?.url;
          const site = typeof url === "string" ? urlSite(url) : undefined;
          if (site) sites.add(site);
        }
        return sites;
      });
    return trustedSitesPromise;
  };
  const routineNamesNewSite = async (prompt: string) => {
    const trusted = await loadTrustedSites();
    const rules = await loadApprovalRules();
    return [...sitesInText(prompt)].some(
      (site) => !trusted.has(site) && !siteAlwaysAllowed(rules, site),
    );
  };
  let trustedConnectorsPromise: Promise<Set<string>> | undefined;
  const loadTrustedConnectors = () => {
    const providers = connectedPlugins.map((plugin) => plugin.provider);
    trustedConnectorsPromise ??= deps.prisma.externalEffect
      .findMany({
        where: { runId, status: { in: PASSED_EFFECT_STATUSES } },
        select: { kind: true, request: true, batchActions: true },
      })
      .then(async (rows) => {
        const trusted = ownerNamedConnectorTrustKeys(
          await loadOwnerWords(),
          connectedPlugins,
          connectorRoutes,
        );
        for (const row of rows) {
          if (BUILTIN_AGENT_TOOL_NAMES.has(row.kind)) continue;
          for (const key of connectorTrustKeys(
            storedBatchActions(row.batchActions),
            boundDirectApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route ??
              catalogApprovalDetails(row.request, CATALOG_APPROVAL_TOOL)?.route,
            connectorKindFromToolName(row.kind, providers),
            providers,
          )) {
            trusted.add(key);
          }
        }
        return trusted;
      });
    return trustedConnectorsPromise;
  };
  // Channel and webhook text this run took in mid-turn is not the owner's. Rows queued
  // before origins were recorded are recognized by their channel message.
  const receivedOutsideMessage = async () =>
    Boolean(
      await deps.prisma.steeringMessage.findFirst({
        where: {
          runId,
          claimedAt: { not: null },
          OR: [
            { originTrigger: { not: null } },
            { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
          ],
        },
        select: { id: true },
      }),
    );
  return {
    loadApprovalRules,
    loadApprovalModel,
    loadAutoReviewPreference,
    loadOwnerWords,
    loadTrustedSites,
    routineNamesNewSite,
    loadTrustedConnectors,
    receivedOutsideMessage,
  };
}
