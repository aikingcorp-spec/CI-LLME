import type { MemorySnapshot } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { truncateUtf8 } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { RouterDeps } from "./router.js";
import { loadMessagePage } from "./thread-message-pages.js";

/** Bound the encoded field too: control characters expand when serialized to JSON. */
function bounded(text: string, maxBytes: number): string {
  let value = truncateUtf8(text, maxBytes);
  while (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes)
    value = truncateUtf8(value, Math.floor(Buffer.byteLength(value, "utf8") / 2));
  return value;
}

function savedMemory(snapshot: MemorySnapshot): string {
  return bounded(
    snapshot.documents
      .slice(0, 8)
      .map(
        (document) =>
          `${bounded(document.path, 128)} (revision ${document.revision})\n${bounded(document.content, 4096)}`,
      )
      .join("\n\n"),
    4096,
  );
}

/** Fresh scoped data, without credential lookups or non-text tool/card payloads. */
export async function realtimeVoiceContext(
  deps: Pick<RouterDeps, "prisma" | "memory">,
  actor: Actor,
  bot: { name: string; instructions: string },
  botId: string,
  signal: AbortSignal,
): Promise<string> {
  const context = { ...createAdapterContext(actor, botId, "voice.context"), signal };
  const [user, thread, userMemory, botMemory] = await Promise.all([
    deps.prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      select: { name: true, timezone: true },
    }),
    deps.prisma.thread.findFirst({
      where: { botId, userId: actor.userId, spaceId: actor.spaceId },
      select: {
        historyCompactionSummary: true,
        id: true,
      },
    }),
    deps.memory.read({ scope: "user" }, context),
    deps.memory.read({ scope: "bot", botId }, context),
  ]);
  signal.throwIfAborted();
  const page = thread ? await loadMessagePage(deps.prisma, thread.id, undefined, 12) : undefined;
  signal.throwIfAborted();
  const messages = (page?.messages ?? [])
    .filter((message) => message.role === "user" || message.role === "bot")
    .map((message) => ({
      role: message.role,
      text: bounded(
        Array.isArray(message.blocks)
          ? message.blocks
              .flatMap((block) =>
                block &&
                typeof block === "object" &&
                "kind" in block &&
                block.kind === "text" &&
                "text" in block &&
                typeof block.text === "string"
                  ? [block.text]
                  : [],
              )
              .join("\n")
          : "",
        512,
      ),
    }));
  return JSON.stringify({
    user: { name: bounded(user.name, 256), timezone: bounded(user.timezone ?? "", 128) },
    bot: { name: bounded(bot.name, 256), instructions: bounded(bot.instructions, 2048) },
    userMemory: savedMemory(userMemory),
    botMemory: savedMemory(botMemory),
    priorConversationSummary: bounded(thread?.historyCompactionSummary ?? "", 2048),
    recentConversation: messages,
  });
}
