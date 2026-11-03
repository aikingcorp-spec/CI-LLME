/** Native ChatGPT-backed voice transport. Pi remains the tool execution runtime. */
export const CODEX_REALTIME_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
] as const;

const CALL_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const MAX_SDP_BYTES = 128 * 1024;

export async function createCodexRealtimeCall(
  input: {
    accessToken: string;
    accountId: string;
    offer: string;
    voice: string;
    instructions: string;
    signal: AbortSignal;
  },
  request: typeof fetch = fetch,
): Promise<string> {
  if (!input.offer.startsWith("v=0") || Buffer.byteLength(input.offer) > MAX_SDP_BYTES)
    throw new Error("Invalid voice connection offer");
  if (!CODEX_REALTIME_VOICES.some((voice) => voice === input.voice))
    throw new Error("This voice is not supported");
  if (!input.accessToken || !input.accountId) throw new Error("Connect a ChatGPT account first");
  const response = await request(CALL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "ChatGPT-Account-ID": input.accountId,
      "content-type": "application/json",
      "OpenAI-Alpha": "quicksilver=v2",
      originator: "vnbot",
    },
    // Frameless Bidi voice IDs and session shape follow Codex's v3 wire adapter.
    // A text-model ID is deliberately not sent to the voice backend.
    body: JSON.stringify({
      sdp: input.offer,
      session: {
        instructions: input.instructions,
        audio: { output: { voice: input.voice } },
        delegation: { type: "client", ack_filler: false },
      },
    }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Provider bodies may contain credentials or private account details.
    throw new Error(
      response.status === 401 || response.status === 403
        ? "ChatGPT voice authorization was rejected. Reconnect the selected account."
        : response.status === 429
          ? "ChatGPT voice is temporarily rate limited. Try again later."
          : `ChatGPT voice is unavailable (HTTP ${response.status})`,
    );
  }
  if (!response.body) throw new Error("The voice service returned no connection answer");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SDP_BYTES) throw new Error("The voice connection answer is too large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let answer = text;
  try {
    const body: unknown = JSON.parse(text);
    answer =
      body && typeof body === "object" && "sdp" in body && typeof body.sdp === "string"
        ? body.sdp
        : "";
  } catch {
    /* The native endpoint also returns plain application/sdp. */
  }
  if (!answer.startsWith("v=0"))
    throw new Error("The voice service returned an invalid connection answer");
  return answer;
}
