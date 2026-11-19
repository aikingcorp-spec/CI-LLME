import type { ConnectorWorkspaceFiles } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import { createSafeRemoteFetch } from "../../../remote-mcp.js";

const WORKSPACE_PATH_HINT =
  'Pass a file path from the bot workspace (for example, "attachments/report.pdf" or a path returned by list_files); the file will be uploaded automatically.';

const MAX_CACHE_ENTRIES = 512;
const MAX_DOWNLOAD_BYTES = ATTACHMENT_MAX_BYTES;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type ComposioUploadedFile = {
  name: string;
  mimetype: string;
  s3key: string;
};

export type ComposioFileUploader = (input: {
  file: File;
  toolSlug: string;
  toolkitSlug: string;
}) => Promise<ComposioUploadedFile>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when a JSON Schema node represents Composio's `file_uploadable` staging descriptor
 * (`file_uploadable: true`, or an un-collapsed `{ name, mimetype, s3key }` object).
 */
export function isFileUploadableNode(node: unknown): boolean {
  if (!isPlainObject(node)) return false;
  if (node.file_uploadable === true) return true;
  if (isPlainObject(node.properties)) {
    const props = node.properties;
    if ("s3key" in props && ("mimetype" in props || "name" in props)) return true;
  }
  return false;
}

function isFileUploadableUnion(node: Record<string, unknown>): "anyOf" | "oneOf" | undefined {
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = node[key];
    if (Array.isArray(variants) && variants.some((variant) => isFileUploadableNode(variant))) {
      return key;
    }
  }
  return undefined;
}

function rewriteLeafToWorkspacePath(node: Record<string, unknown>): Record<string, unknown> {
  const existing = typeof node.description === "string" ? node.description.trim() : "";
  const description = existing
    ? existing.includes("uploaded automatically")
      ? existing
      : `${existing} ${WORKSPACE_PATH_HINT}`
    : WORKSPACE_PATH_HINT;
  const rewritten: Record<string, unknown> = {
    type: "string",
    format: "path",
    description,
  };
  if (typeof node.title === "string") rewritten.title = node.title;
  if (node.nullable === true) rewritten.nullable = true;
  return rewritten;
}

/**
 * Rewrites `file_uploadable` schema fields into workspace file path strings so the model never
 * sees Composio's internal `{ name, mimetype, s3key }` descriptor, and returns the top-level
 * parameter keys that require file staging at execute time.
 */
export function rewriteFileUploadableSchema(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  fileFields: Set<string>;
} {
  const fileFields = new Set<string>();
  const rawProps = schema.properties;
  if (!isPlainObject(rawProps)) return { schema, fileFields };

  let changed = false;
  const nextProps: Record<string, unknown> = {};
  for (const [key, propValue] of Object.entries(rawProps)) {
    if (!isPlainObject(propValue)) {
      nextProps[key] = propValue;
      continue;
    }
    if (isFileUploadableNode(propValue)) {
      fileFields.add(key);
      nextProps[key] = rewriteLeafToWorkspacePath(propValue);
      changed = true;
      continue;
    }
    const unionKey = isFileUploadableUnion(propValue);
    if (unionKey) {
      fileFields.add(key);
      const variants = propValue[unionKey] as unknown[];
      const rewrittenVariants = variants.map((variant) =>
        isFileUploadableNode(variant)
          ? rewriteLeafToWorkspacePath(variant as Record<string, unknown>)
          : variant,
      );
      const existing =
        typeof propValue.description === "string" ? propValue.description.trim() : "";
      nextProps[key] = {
        ...propValue,
        [unionKey]: rewrittenVariants,
        description: existing
          ? existing.includes("uploaded automatically")
            ? existing
            : `${existing} ${WORKSPACE_PATH_HINT}`
          : WORKSPACE_PATH_HINT,
      };
      changed = true;
      continue;
    }
    if (propValue.type === "array" && isFileUploadableNode(propValue.items)) {
      fileFields.add(key);
      nextProps[key] = {
        ...propValue,
        items: rewriteLeafToWorkspacePath(propValue.items as Record<string, unknown>),
      };
      changed = true;
      continue;
    }
    nextProps[key] = propValue;
  }

  return {
    schema: changed ? { ...schema, properties: nextProps } : schema,
    fileFields,
  };
}

/**
 * Walks dynamic tool-discovery payloads (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS`),
 * rewrites any embedded `file_uploadable` input schemas to workspace paths, and invokes `onTool`
 * with each tool's discovered upload fields so execute-time staging needs no extra lookup.
 */
export function rewriteDiscoveredToolSchemas(
  payload: unknown,
  onTool: (toolSlug: string, fileFields: Set<string>) => void,
): unknown {
  const walk = (node: unknown, inheritedSlug?: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item));
    }
    if (!isPlainObject(node)) return node;

    const slug =
      typeof node.tool_slug === "string"
        ? node.tool_slug
        : typeof node.slug === "string"
          ? node.slug
          : typeof node.name === "string" &&
              (isPlainObject(node.input_schema) ||
                isPlainObject(node.inputParameters) ||
                isPlainObject(node.parameters))
            ? node.name
            : inheritedSlug;

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === "input_schema" || key === "inputParameters" || key === "parameters") &&
        isPlainObject(value) &&
        isPlainObject(value.properties)
      ) {
        const rewritten = rewriteFileUploadableSchema(value);
        if (slug) onTool(slug, rewritten.fileFields);
        if (rewritten.schema !== value) changed = true;
        out[key] = rewritten.schema;
        continue;
      }
      // `tool_schemas` maps `{ TOOL_SLUG: { input_schema: ... } }` in ToolRouter responses.
      const childSlug =
        key === "tool_schemas" || key === "schemas"
          ? undefined
          : /^[A-Z0-9]+_[A-Z0-9_]+$/.test(key)
            ? key
            : slug;
      const next = walk(value, childSlug);
      if (next !== value) changed = true;
      out[key] = next;
    }
    return changed ? out : node;
  };
  return walk(payload);
}

/** Bounded cache mapping uppercased Composio tool slugs to their file-uploadable arg names. */
export class ComposioFileFieldCache {
  private readonly entries = new Map<string, Set<string>>();

  get(toolSlug: string): Set<string> | undefined {
    return this.entries.get(toolSlug.toUpperCase());
  }

  set(toolSlug: string, fields: Set<string>): void {
    const key = toolSlug.toUpperCase();
    if (!key) return;
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, new Set(fields));
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAlreadyStagedFile(value: unknown): boolean {
  return isPlainObject(value) && typeof value.s3key === "string" && value.s3key.trim().length > 0;
}

function extractWorkspacePath(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || isHttpUrl(trimmed)) return undefined;
    return trimmed;
  }
  if (isPlainObject(value) && !isAlreadyStagedFile(value)) {
    for (const key of ["path", "file_path", "local_path", "workspace_path"]) {
      const candidate = value[key];
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed && !isHttpUrl(trimmed)) return trimmed;
      }
    }
  }
  return undefined;
}

/**
 * Stages any workspace-path arguments for a tool's `file_uploadable` fields by reading the file
 * through `workspaceFiles.readFile` and uploading it via `uploadFile`.
 */
export async function stageComposioUploadArgs(input: {
  toolSlug: string;
  toolkitSlug: string;
  args: Record<string, unknown>;
  fileFields: ReadonlySet<string>;
  workspaceFiles: ConnectorWorkspaceFiles | undefined;
  uploadFile: ComposioFileUploader;
}): Promise<Record<string, unknown>> {
  if (input.fileFields.size === 0) return input.args;
  let staged: Record<string, unknown> | undefined;

  const uploadOne = async (value: unknown): Promise<unknown> => {
    if (isAlreadyStagedFile(value)) return value;
    const localPath = extractWorkspacePath(value);
    if (!localPath) return value;
    if (!input.workspaceFiles) {
      throw new Error(
        `Cannot upload "${localPath}": no workspace computer is available to read local files.`,
      );
    }
    const loaded = await input.workspaceFiles.readFile(localPath);
    const bytes = new Uint8Array(loaded.bytes.byteLength);
    bytes.set(loaded.bytes);
    const file = new File([bytes], loaded.name, { type: loaded.mimeType });
    const uploaded = await input.uploadFile({
      file,
      toolSlug: input.toolSlug,
      toolkitSlug: input.toolkitSlug,
    });
    return {
      name: uploaded.name || loaded.name,
      mimetype: uploaded.mimetype || loaded.mimeType,
      s3key: uploaded.s3key,
    };
  };

  for (const field of input.fileFields) {
    if (!(field in input.args)) continue;
    const current = input.args[field];
    if (current === undefined || current === null) continue;
    if (Array.isArray(current)) {
      const nextArray = await Promise.all(current.map((entry) => uploadOne(entry)));
      if (nextArray.some((entry, idx) => entry !== current[idx])) {
        staged ??= { ...input.args };
        staged[field] = nextArray;
      }
      continue;
    }
    const nextValue = await uploadOne(current);
    if (nextValue !== current) {
      staged ??= { ...input.args };
      staged[field] = nextValue;
    }
  }

  return staged ?? input.args;
}

function isDownloadableFileObject(
  value: unknown,
): value is Record<string, unknown> & { s3url: string } {
  return (
    isPlainObject(value) &&
    typeof value.s3url === "string" &&
    value.s3url.startsWith("https://") &&
    typeof value.workspace_path !== "string"
  );
}

function downloadFileName(record: Record<string, unknown>, s3url: string): string {
  if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
  try {
    const pathname = new URL(s3url).pathname;
    const base = pathname.split("/").pop();
    if (base?.includes(".")) return decodeURIComponent(base);
  } catch {
    // Ignore malformed URLs; safe fetch will reject if invalid.
  }
  return "download.bin";
}

async function readResponseCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > maxBytes) {
    cancelResponseBody(response);
    throw new Error(`Downloaded file exceeds ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await bestEffort("cancel oversized composio download", reader.cancel());
        throw new Error(`Downloaded file exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * When a Composio tool returns downloaded file descriptors (`{ s3url, name, mimetype }`),
 * downloads them via SSRF-safe HTTPS fetch into the bot's workspace and annotates each entry
 * with `workspace_path`. Download failures are logged and leave the original payload intact.
 */
export async function stageComposioDownloadResults(input: {
  data: unknown;
  workspaceFiles: ConnectorWorkspaceFiles | undefined;
  signal: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  resolve?: Parameters<typeof createSafeRemoteFetch>[1];
}): Promise<unknown> {
  if (!input.workspaceFiles) return input.data;
  const workspaceFiles = input.workspaceFiles;

  const targets: Array<{
    record: Record<string, unknown> & { s3url: string };
  }> = [];
  const collect = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!isPlainObject(node)) return;
    if (isDownloadableFileObject(node)) {
      targets.push({ record: node });
      return;
    }
    for (const value of Object.values(node)) collect(value);
  };
  collect(input.data);
  if (targets.length === 0) return input.data;

  const safeFetch = createSafeRemoteFetch(input.fetchImpl, input.resolve);
  const savedPaths = new Map<Record<string, unknown>, string>();
  try {
    for (const { record } of targets.slice(0, 5)) {
      const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      const signal = AbortSignal.any([input.signal, timeout]);
      try {
        const response = await safeFetch(record.s3url, { method: "GET", signal });
        if (!response.ok) {
          cancelResponseBody(response);
          continue;
        }
        const bytes = await readResponseCapped(response, MAX_DOWNLOAD_BYTES, signal);
        const saved = await workspaceFiles.writeFile(downloadFileName(record, record.s3url), bytes);
        savedPaths.set(record, saved.path);
      } catch (error) {
        getLogger().warn("composio file download staging skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    bestEffort("composio-file-staging:close-fetch", safeFetch.close());
  }

  if (savedPaths.size === 0) return input.data;
  const annotate = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map((item) => annotate(item));
    if (!isPlainObject(node)) return node;
    const saved = savedPaths.get(node);
    if (saved) return { ...node, workspace_path: saved };
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const next = annotate(value);
      if (next !== value) changed = true;
      out[key] = next;
    }
    return changed ? out : node;
  };
  return annotate(input.data);
}
