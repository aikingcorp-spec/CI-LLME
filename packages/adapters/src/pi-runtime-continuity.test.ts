import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

it.each([true, false])(
  "applies the personal opt-in to the same Pi loop without repeating effects (enabled=%s)",
  async (enabled) => {
    const requests: Record<string, unknown>[] = [];
    let ordinary = 0;
    let reviews = 0;
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const review = body.messages?.some(
        (message: { content?: unknown }) =>
          typeof message.content === "string" &&
          message.content.includes("Review whether a tool-using assistant"),
      );
      let delta: Record<string, unknown>;
      let finish = "stop";
      if (review) {
        reviews += 1;
        delta = {
          role: "assistant",
          content: JSON.stringify(
            reviews === 1
              ? { outcome: "continue", nextStep: "Create teammate B." }
              : { outcome: "complete" },
          ),
        };
      } else {
        ordinary += 1;
        if (ordinary === 1 || ordinary === 3) {
          finish = "tool_calls";
          delta = {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `effect-${ordinary}`,
                type: "function",
                function: {
                  name: "create_teammate",
                  arguments: JSON.stringify({ name: ordinary === 1 ? "A" : "B" }),
                },
              },
            ],
          };
        } else
          delta = { role: "assistant", content: ordinary === 2 ? "Created A." : "Both created." };
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture unavailable");
    const executeTool = vi.fn(async (_name, args) => ({ created: args.name }));
    const events: AgentRuntimeEvent[] = [];
    try {
      for await (const event of new PiAgentRuntime({ continuityReview: true }).run(
        {
          botId: "fixture-bot",
          threadId: "fixture-thread",
          runId: "continuity-fixture",
          prompt: "Create teammates A and B.",
          taskContinuity: enabled,
          instructions: "Fixture",
          history: [],
          tools: [
            {
              name: "create_teammate",
              description: "Create a teammate",
              inputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          ],
          executeTool,
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            allowPrivateEndpoint: true,
          },
        },
        { signal: AbortSignal.timeout(15_000) },
      ))
        events.push(event);
      expect(executeTool.mock.calls.map((call) => call[1])).toEqual(
        enabled ? [{ name: "A" }, { name: "B" }] : [{ name: "A" }],
      );
      expect(reviews).toBe(enabled ? 2 : 0);
      expect(ordinary).toBe(enabled ? 4 : 2);
      expect(requests).toHaveLength(enabled ? 6 : 2);
      expect(
        events.filter((event) => event.type === "usage" && event.operationKind === "setup"),
      ).toHaveLength(enabled ? 2 : 0);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        text: enabled ? "Created A.Both created." : "Created A.",
      });
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  },
);
