/** Offline provider HTTP; the public catalog deliberately accepts rejected keys. */
export function createModelConnectionFixtureFetch(
  catalog: ReadonlyArray<{ provider: string; id: string }>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (
      request.url === "https://openrouter.ai/api/v1/key" ||
      request.url === "https://ollama.com/api/balance"
    ) {
      const authorization = request.headers.get("authorization");
      const accepted =
        authorization?.startsWith("Bearer ") && authorization !== "Bearer rejected-fixture-key";
      return Response.json({ data: {} }, { status: accepted ? 200 : 401 });
    }
    if (request.url === "https://openrouter.ai/api/v1/models") {
      return Response.json({
        data: catalog
          .filter((model) => model.provider === "openrouter")
          .map((model) => ({ id: model.id })),
      });
    }
    if (request.url === "https://ollama.com/v1/models") {
      return Response.json({ data: [{ id: "fixture-model" }] });
    }
    const url = new URL(request.url);
    // The address specs type into the compatible-server form; nothing listens there.
    if (request.url === "http://127.0.0.1:8090/v1/models")
      return Response.json({ data: [{ id: "fixture-model" }] });
    // A spec that starts its own model server on loopback talks to it for real.
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      return fetch(request.url, { headers: request.headers, signal: request.signal });
    throw new Error("Unexpected model connection request in the offline fixture");
  };
}
