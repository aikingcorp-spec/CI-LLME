import { executePurchaseTool } from "./purchase-service.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

// The effect key is stable across replays, so a retried request reuses its purchase.
const purchaseContext = (ctx: RunContext, call: ToolCall) => ({
  ...ctx.context,
  operationId: call.effectKey,
  botId: ctx.bot.id,
});

async function purchaseTool(ctx: RunContext, call: ToolCall) {
  return call.finish(
    await executePurchaseTool(ctx.deps, purchaseContext(ctx, call), ctx.run, call.name, call.args),
  );
}

/** Purchases from the user's connected wallet. */
export const purchaseTools: ToolHandlers = {
  purchase_status: purchaseTool,
};
