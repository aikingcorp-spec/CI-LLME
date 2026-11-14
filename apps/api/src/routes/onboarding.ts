import { ORPCError } from "@orpc/server";
import { signupSurveyAsksTeamSize } from "@rakazo/contracts";
import {
  chooseFocus,
  dismissFocus,
  markAppConnected,
  promptFocus,
  startOnboarding,
} from "../onboarding.js";
import type { RouterContext } from "./context.js";

export function onboardingRoutes(ctx: RouterContext) {
  const { deps, onboardingDeps, authed } = ctx;
  return {
    onboarding: {
      signupSurvey: authed.onboarding.signupSurvey.handler(async ({ context, input }) => {
        const answers = {
          reason: input.reason || null,
          use: input.use ?? null,
          teamSize: signupSurveyAsksTeamSize(input.use) ? (input.teamSize ?? null) : null,
          source: input.source || null,
        };
        const saved = await deps.prisma.signupSurvey.upsert({
          where: { userId: context.actor.userId },
          create: { userId: context.actor.userId, ...answers },
          update: answers,
        });
        deps.analytics?.capture(
          context.actor.userId,
          {
            name: "signup_survey_answered",
            skipped: Object.values(answers).every((answer) => answer === null),
            ...(answers.use ? { use: answers.use } : {}),
            ...(answers.teamSize ? { teamSize: answers.teamSize } : {}),
          },
          // The first save's time keeps a resubmission a duplicate of the same event.
          { id: context.actor.userId, at: saved.createdAt },
        );
        return { ok: true as const };
      }),
      start: authed.onboarding.start.handler(async ({ context, input }) => {
        await startOnboarding(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      promptFocus: authed.onboarding.promptFocus.handler(async ({ context, input }) => {
        await promptFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      choose: authed.onboarding.choose.handler(async ({ context, input }) => {
        await chooseFocus(onboardingDeps, context.actor, input.botId, input.optionId);
        return { ok: true as const };
      }),
      dismissFocus: authed.onboarding.dismissFocus.handler(async ({ context, input }) => {
        await dismissFocus(onboardingDeps, context.actor, input.botId);
        return { ok: true as const };
      }),
      appConnected: authed.onboarding.appConnected.handler(async ({ context, input }) => {
        await markAppConnected(
          onboardingDeps,
          context.actor,
          input.botId,
          input.provider,
          input.connectorId,
          input.threadId,
          input.messageId,
        );
        return { ok: true as const };
      }),
    },
    // VNBot: one Composio key per install, pasted in Marketplace by the install owner; every
    // account here uses it and connects its own app accounts.
    integrationSetup: {
      get: authed.integrationSetup.get.handler(async ({ context }) => {
        const settings = deps.integrationSettings;
        const webUrl = new URL("/integrations/setup", deps.env.webOrigin).toString();
        if (!settings) return { canConfigure: false, needsSetup: false, webUrl, providers: [] };
        const owner = await settings.canManageKey(context.actor.userId);
        const configured = !(await settings.needsPersonalKey(context.actor.userId));
        return {
          canConfigure: owner,
          needsSetup: owner && !configured,
          webUrl,
          providers: [{ id: "composio" as const, configured }],
        };
      }),
      save: authed.integrationSetup.save.handler(async ({ context, input }) => {
        const settings = deps.integrationSettings;
        if (
          input.provider !== "composio" ||
          !settings ||
          !(await settings.canManageKey(context.actor.userId))
        )
          throw new ORPCError("FORBIDDEN");
        try {
          await settings.savePersonalKey(input.apiKey, {
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            operationId: "integrationSetup.save",
            traceId: "integrationSetup.save",
            signal: AbortSignal.any([
              context.signal ?? new AbortController().signal,
              AbortSignal.timeout(15_000),
            ]),
          });
          return { ok: true as const };
        } catch {
          // Provider errors can carry account details; never echo them.
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not save your Composio key. Check the key and try again.",
          });
        }
      }),
      remove: authed.integrationSetup.remove.handler(async ({ context }) => {
        const settings = deps.integrationSettings;
        if (!settings || !(await settings.canManageKey(context.actor.userId)))
          throw new ORPCError("FORBIDDEN");
        await settings.revokePersonal(context.actor.userId);
        return { ok: true as const };
      }),
    },
  };
}
