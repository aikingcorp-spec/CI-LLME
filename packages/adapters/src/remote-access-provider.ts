import type { RemoteAccessProvider } from "@rakazo/core";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";

const API = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 1_000_000;
const ID = /^[a-f0-9]{32}$/i;
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGICAL_HOST = /^h[a-f0-9]{32}$/;
const NAME_SUFFIX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export interface RemoteAccessConnection {
  accountId: string;
  zoneId: string;
  apiToken: string;
  /** Public DNS suffix. The stable name is the logical host plus this suffix. */
  nameSuffix: string;
  /**
   * Loopback HTTP origin used when a call does not name one.
   * WebSocket upgrades stay on this same service.
   */
  originService?: string;
  fetch?: typeof fetch;
  /**
   * Receives the connector token. The token must not be written to the portal,
   * a client response, or the stored object id.
   */
  onRunToken: (input: { objectId: string; logicalHost: string; runToken: string }) => void;
}

interface ListedTunnel {
  id: string;
  name: string;
}

interface ListedRecord {
  id: string;
  name: string;
  content: string;
}

/**
 * Remotely managed connector. A retry finds the existing object by its stable
 * name instead of creating another. Nothing here is selected unless a deployment
 * passes this connection, and the host install is not that deployment.
 */
export function createRemoteAccessProvider(config: RemoteAccessConnection): RemoteAccessProvider {
  const accountId = requiredId(config.accountId, "account");
  const zoneId = requiredId(config.zoneId, "zone");
  const apiToken = requiredToken(config.apiToken);
  const nameSuffix = requiredSuffix(config.nameSuffix);
  const configuredOrigin = config.originService ? requiredOrigin(config.originService) : undefined;
  const request = config.fetch ?? fetch;
  const onRunToken = config.onRunToken;

  async function call(method: string, path: string, body?: unknown, missingOk = false) {
    const response = await request(`${API}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (missingOk && response.status === 404) {
      cancelResponseBody(response);
      return undefined;
    }
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error("Remote access provider request failed");
    }
    const payload = await readBoundedJsonResponse<unknown>(response, MAX_RESPONSE_BYTES);
    if (field(payload, "success") !== true)
      throw new Error("Remote access provider request failed");
    return field(payload, "result");
  }

  async function findTunnel(name: string): Promise<ListedTunnel | undefined> {
    const result = await call(
      "GET",
      `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
    );
    if (!Array.isArray(result)) throw new Error("Remote access provider request failed");
    const matches = result.flatMap((item) => {
      const id = field(item, "id");
      const listed = field(item, "name");
      const deleted = field(item, "deleted_at");
      if (typeof id !== "string" || !OBJECT_ID.test(id) || listed !== name || deleted) return [];
      return [{ id, name }];
    });
    if (matches.length > 1) throw new Error("Remote access provider request failed");
    return matches[0];
  }

  async function runTokenFor(objectId: string, created: unknown): Promise<string> {
    const createdToken = field(created, "token");
    if (typeof createdToken === "string" && createdToken) return createdToken;
    const result = await call("GET", `/accounts/${accountId}/cfd_tunnel/${objectId}/token`);
    const token = typeof result === "string" ? result : field(result, "token");
    if (typeof token !== "string" || !token)
      throw new Error("Remote access provider request failed");
    return token;
  }

  function hostname(logicalHost: string): string {
    return remoteConnectorHostname(logicalHost, nameSuffix);
  }

  function target(objectId: string): string {
    return `${objectId}.cfargotunnel.com`;
  }

  async function recordsFor(name: string): Promise<ListedRecord[]> {
    const result = await call(
      "GET",
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
    );
    if (!Array.isArray(result)) throw new Error("Remote access provider request failed");
    return result.flatMap((item) => {
      const id = field(item, "id");
      const listed = field(item, "name");
      const content = field(item, "content");
      if (typeof id !== "string" || !id || listed !== name || typeof content !== "string")
        return [];
      return [{ id, name, content }];
    });
  }

  async function ensureName(name: string, objectId: string): Promise<void> {
    const content = target(objectId);
    const records = await recordsFor(name);
    const current = records[0];
    if (records.length > 1) throw new Error("Remote access provider request failed");
    const body = { type: "CNAME", proxied: true, name, content };
    if (!current) {
      await call("POST", `/zones/${zoneId}/dns_records`, body);
      return;
    }
    if (current.content === content) return;
    await call("PUT", `/zones/${zoneId}/dns_records/${current.id}`, body);
  }

  return {
    async provision(input) {
      if (!LOGICAL_HOST.test(input.logicalHost)) {
        throw new Error("Remote access provider request failed");
      }
      const name = hostname(input.logicalHost);
      let existing = await findTunnel(input.logicalHost);
      let created: unknown;
      if (!existing) {
        try {
          created = await call("POST", `/accounts/${accountId}/cfd_tunnel`, {
            name: input.logicalHost,
            config_src: "cloudflare",
          });
          const id = field(created, "id");
          if (typeof id === "string" && OBJECT_ID.test(id))
            existing = { id, name: input.logicalHost };
        } catch {
          existing = await findTunnel(input.logicalHost);
        }
      }
      if (!existing) throw new Error("Remote access provider request failed");
      const originService = input.originService
        ? requiredOrigin(input.originService)
        : configuredOrigin;
      if (!originService) throw new Error("Remote access origin is invalid");
      await call("PUT", `/accounts/${accountId}/cfd_tunnel/${existing.id}/configurations`, {
        config: {
          ingress: [
            { hostname: name, service: originService, originRequest: {} },
            { service: "http_status:404" },
          ],
        },
      });
      await ensureName(name, existing.id);
      const runToken = await runTokenFor(existing.id, created);
      if (runToken === existing.id) throw new Error("Remote access provider request failed");
      onRunToken({ objectId: existing.id, logicalHost: input.logicalHost, runToken });
      return { objectId: existing.id };
    },
    async release(input) {
      if (!OBJECT_ID.test(input.objectId)) throw new Error("Remote access provider request failed");
      await call(
        "DELETE",
        `/accounts/${accountId}/cfd_tunnel/${input.objectId}/connections`,
        undefined,
        true,
      );
      await call("DELETE", `/accounts/${accountId}/cfd_tunnel/${input.objectId}`, undefined, true);
      const records = await connectorRecords(call, zoneId, input.objectId);
      for (const record of records) {
        await call("DELETE", `/zones/${zoneId}/dns_records/${record.id}`, undefined, true);
      }
    },
  };
}

async function connectorRecords(
  call: (method: string, path: string, body?: unknown, missingOk?: boolean) => Promise<unknown>,
  zoneId: string,
  objectId: string,
): Promise<Array<{ id: string }>> {
  const content = `${objectId}.cfargotunnel.com`;
  const result = await call(
    "GET",
    `/zones/${zoneId}/dns_records?type=CNAME&content=${encodeURIComponent(content)}`,
  );
  if (!Array.isArray(result)) throw new Error("Remote access provider request failed");
  return result.flatMap((item) => {
    const id = field(item, "id");
    if (field(item, "content") !== content || typeof id !== "string" || !id) return [];
    return [{ id }];
  });
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

function requiredId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`Remote access ${label} is invalid`);
  return value.toLowerCase();
}

function requiredToken(value: string): string {
  if (!value || value.length > 4096) throw new Error("Remote access token is invalid");
  return value;
}

/** The public name is one label under the zone, so a single-level wildcard certificate matches. */
export function remoteConnectorHostname(logicalHost: string, zoneName: string): string {
  if (!LOGICAL_HOST.test(logicalHost)) throw new Error("Remote access name is invalid");
  return `${logicalHost}.${requiredSuffix(zoneName)}`;
}

function requiredSuffix(value: string): string {
  const suffix = value.trim().toLowerCase().replace(/\.$/, "");
  if (!NAME_SUFFIX.test(suffix) || suffix.length > 200) {
    throw new Error("Remote access name is invalid");
  }
  return suffix;
}

function requiredOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote access origin is invalid");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Remote access origin is invalid");
  }
  return url.origin;
}
