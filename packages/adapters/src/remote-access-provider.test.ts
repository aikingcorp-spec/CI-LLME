import { expect, it } from "vitest";
import { createRemoteAccessProvider, remoteConnectorHostname } from "./remote-access-provider.js";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const apiToken = "api-token-not-for-the-connector";
const logicalHost = `h${"c".repeat(32)}`;
const objectId = "11111111-1111-4111-8111-111111111111";
const runToken = "eyJ-test-connector-token";
const tunnelSecret = "tunnel-secret-must-not-leak";
const origin = "http://127.0.0.1:8787";
const suffix = "remote.example.test";
const hostname = `${logicalHost}.${suffix}`;
const target = `${objectId}.cfargotunnel.com`;

interface Call {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

function provider(options: {
  tunnels: Array<{ id: string; name: string }>;
  records: Array<{ id: string; name: string; type: string; content: string }>;
  failCreate?: boolean;
}) {
  const calls: Call[] = [];
  const tokens: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, authorization, body });
    if (url.origin !== "https://api.cloudflare.com") return new Response(null, { status: 500 });
    if (method === "GET" && url.pathname.endsWith("/cfd_tunnel")) {
      return json(options.tunnels.filter((item) => item.name === url.searchParams.get("name")));
    }
    if (method === "POST" && url.pathname.endsWith("/cfd_tunnel")) {
      if (options.failCreate) {
        options.failCreate = false;
        options.tunnels.push({ id: objectId, name: logicalHost });
        return new Response(null, { status: 409 });
      }
      options.tunnels.push({ id: objectId, name: logicalHost });
      return json({
        id: objectId,
        token: runToken,
        credentials_file: { TunnelSecret: tunnelSecret },
      });
    }
    if (method === "GET" && url.pathname.endsWith("/token")) return json(runToken);
    if (method === "PUT" && url.pathname.endsWith("/configurations")) return json({ id: objectId });
    if (method === "GET" && url.pathname.endsWith("/dns_records")) {
      const name = url.searchParams.get("name");
      const content = url.searchParams.get("content");
      return json(
        options.records.filter(
          (item) =>
            (name === null || item.name === name) && (content === null || item.content === content),
        ),
      );
    }
    if (method === "POST" && url.pathname.endsWith("/dns_records")) {
      options.records.push({ id: "dns-1", name: hostname, type: "CNAME", content: target });
      return json(options.records[0]);
    }
    if (method === "DELETE") {
      options.records = options.records.filter((item) => !url.pathname.endsWith(`/${item.id}`));
      return json({ id: objectId });
    }
    return new Response(null, { status: 500 });
  };
  const access = createRemoteAccessProvider({
    accountId,
    zoneId,
    apiToken,
    nameSuffix: suffix,
    originService: origin,
    fetch: fetchImpl,
    onRunToken: (input) => tokens.push(input.runToken),
  });
  return { access, calls, tokens, options };
}

function json(result: unknown) {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function connection() {
  return provider({ tunnels: [], records: [] });
}

it("creates one remotely managed connector and keeps the run token out of the object id", async () => {
  const { access, calls, tokens } = connection();
  await expect(
    access.provision({ accountId: "user", deviceId: "device", logicalHost }),
  ).resolves.toEqual({
    objectId,
  });
  expect(tokens).toEqual([runToken]);
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    `GET /client/v4/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${logicalHost}`,
    `POST /client/v4/accounts/${accountId}/cfd_tunnel`,
    `PUT /client/v4/accounts/${accountId}/cfd_tunnel/${objectId}/configurations`,
    `GET /client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    `POST /client/v4/zones/${zoneId}/dns_records`,
  ]);
  expect(calls[1]?.body).toEqual({ name: logicalHost, config_src: "cloudflare" });
  expect(calls[2]?.body).toEqual({
    config: {
      ingress: [{ hostname, service: origin, originRequest: {} }, { service: "http_status:404" }],
    },
  });
  expect(calls[4]?.body).toEqual({ type: "CNAME", proxied: true, name: hostname, content: target });
  const published = JSON.stringify(calls.map(({ method, path, body }) => ({ method, path, body })));
  expect(published).not.toContain(runToken);
  expect(published).not.toContain(tunnelSecret);
  expect(published).not.toContain(apiToken);
  expect(calls.every((call) => call.authorization === `Bearer ${apiToken}`)).toBe(true);
});

it("reuses the existing connector when a retry finds the same name", async () => {
  const state = provider({
    tunnels: [{ id: objectId, name: logicalHost }],
    records: [{ id: "dns-1", name: hostname, type: "CNAME", content: target }],
  });
  await expect(
    state.access.provision({ accountId: "user", deviceId: "device", logicalHost }),
  ).resolves.toEqual({ objectId });
  expect(
    state.calls.some((call) => call.method === "POST" && call.path.endsWith("/cfd_tunnel")),
  ).toBe(false);
  expect(
    state.calls.some((call) => call.method === "POST" && call.path.endsWith("/dns_records")),
  ).toBe(false);
  expect(state.calls.some((call) => call.path.endsWith("/token"))).toBe(true);
  expect(state.tokens).toEqual([runToken]);
});

it("finds the connector again when creation loses the race", async () => {
  const state = provider({ tunnels: [], records: [], failCreate: true });
  await expect(
    state.access.provision({ accountId: "user", deviceId: "device", logicalHost }),
  ).resolves.toEqual({ objectId });
  expect(
    state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/cfd_tunnel")),
  ).toHaveLength(1);
});

it("removes connections before the connector and then the public name", async () => {
  const state = provider({
    tunnels: [{ id: objectId, name: logicalHost }],
    records: [{ id: "dns-1", name: hostname, type: "CNAME", content: target }],
  });
  await state.access.release({ objectId });
  expect(state.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    `DELETE /client/v4/accounts/${accountId}/cfd_tunnel/${objectId}/connections`,
    `DELETE /client/v4/accounts/${accountId}/cfd_tunnel/${objectId}`,
    `GET /client/v4/zones/${zoneId}/dns_records?type=CNAME&content=${encodeURIComponent(target)}`,
    `DELETE /client/v4/zones/${zoneId}/dns_records/dns-1`,
  ]);
  expect(JSON.stringify(state.calls)).not.toContain(runToken);
});

it("adds one label so the name under app.vnbot.run matches the published wildcard", () => {
  expect(remoteConnectorHostname(logicalHost, "app.vnbot.run")).toBe(
    `${logicalHost}.app.vnbot.run`,
  );
  expect(remoteConnectorHostname(logicalHost, "vnbot.run")).toBe(`${logicalHost}.vnbot.run`);
});

it("rejects an origin that is not the local host", () => {
  expect(() =>
    createRemoteAccessProvider({
      accountId,
      zoneId,
      apiToken,
      nameSuffix: suffix,
      originService: "https://app.example.test",
      onRunToken: () => undefined,
    }),
  ).toThrow("origin");
});
