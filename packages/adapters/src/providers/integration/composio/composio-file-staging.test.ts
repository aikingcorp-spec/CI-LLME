import type { ConnectorWorkspaceFiles } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  ComposioFileFieldCache,
  isFileUploadableNode,
  rewriteDiscoveredToolSchemas,
  rewriteFileUploadableSchema,
  stageComposioDownloadResults,
  stageComposioUploadArgs,
} from "./composio-file-staging.js";

function makeWorkspaceFiles(files: Record<string, { bytes: Uint8Array; mimeType: string }>): {
  workspaceFiles: ConnectorWorkspaceFiles;
  written: Array<{ fileName: string; content: Uint8Array }>;
} {
  const written: Array<{ fileName: string; content: Uint8Array }> = [];
  const workspaceFiles: ConnectorWorkspaceFiles = {
    readFile: vi.fn(async (workspacePath: string) => {
      const entry = files[workspacePath];
      if (!entry) throw new Error(`File not found: ${workspacePath}`);
      const name = workspacePath.split("/").pop() || workspacePath;
      return { bytes: entry.bytes, name, mimeType: entry.mimeType };
    }),
    writeFile: vi.fn(async (fileName: string, content: Uint8Array) => {
      written.push({ fileName, content });
      return { path: `downloads/${fileName}` };
    }),
  };
  return { workspaceFiles, written };
}

const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];

describe("composio file staging", () => {
  it("rewrites direct file_uploadable properties to workspace path strings", () => {
    const schema = {
      type: "object",
      required: ["file_to_upload"],
      properties: {
        file_to_upload: {
          type: "object",
          file_uploadable: true,
          description: "File to upload to Google Drive.",
          properties: {
            name: { type: "string" },
            mimetype: { type: "string" },
            s3key: { type: "string" },
          },
          required: ["name", "mimetype", "s3key"],
        },
        folder_id: { type: "string" },
      },
    };

    const { schema: rewritten, fileFields } = rewriteFileUploadableSchema(schema);
    expect([...fileFields]).toEqual(["file_to_upload"]);
    const props = rewritten.properties as Record<string, Record<string, unknown>>;
    expect(props.file_to_upload?.type).toBe("string");
    expect(props.file_to_upload?.properties).toBeUndefined();
    expect(String(props.file_to_upload?.description)).toContain("bot workspace");
    expect(props.folder_id).toEqual({ type: "string" });
  });

  it("rewrites nullable anyOf and array file_uploadable fields", () => {
    const schema = {
      type: "object",
      properties: {
        attachment: {
          anyOf: [
            {
              type: "object",
              file_uploadable: true,
              properties: {
                name: { type: "string" },
                mimetype: { type: "string" },
                s3key: { type: "string" },
              },
            },
            { type: "null" },
          ],
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              mimetype: { type: "string" },
              s3key: { type: "string" },
            },
          },
        },
      },
    };

    const { schema: rewritten, fileFields } = rewriteFileUploadableSchema(schema);
    expect([...fileFields].sort()).toEqual(["attachment", "attachments"]);
    const props = rewritten.properties as Record<string, Record<string, unknown>>;
    const variants = props.attachment?.anyOf as Array<Record<string, unknown>>;
    expect(variants[0]?.type).toBe("string");
    expect(variants[1]).toEqual({ type: "null" });
    const arrayItems = props.attachments?.items as Record<string, unknown>;
    expect(arrayItems.type).toBe("string");
  });

  it("leaves schemas without file_uploadable fields untouched", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
    };
    expect(isFileUploadableNode(schema.properties.query)).toBe(false);
    const result = rewriteFileUploadableSchema(schema);
    expect(result.schema).toBe(schema);
    expect(result.fileFields.size).toBe(0);
  });

  it("rewrites dynamic schemas returned by COMPOSIO_GET_TOOL_SCHEMAS and records fields", () => {
    const cache = new ComposioFileFieldCache();
    const payload = {
      tool_schemas: {
        GOOGLEDRIVE_UPLOAD_FILE: {
          tool_slug: "GOOGLEDRIVE_UPLOAD_FILE",
          input_schema: {
            type: "object",
            properties: {
              file_to_upload: {
                type: "object",
                file_uploadable: true,
                properties: {
                  name: { type: "string" },
                  mimetype: { type: "string" },
                  s3key: { type: "string" },
                },
              },
            },
          },
        },
      },
    };

    const rewritten = rewriteDiscoveredToolSchemas(payload, (slug, fields) =>
      cache.set(slug, fields),
    ) as typeof payload;

    expect([...(cache.get("GOOGLEDRIVE_UPLOAD_FILE") ?? [])]).toEqual(["file_to_upload"]);
    const field = rewritten.tool_schemas.GOOGLEDRIVE_UPLOAD_FILE.input_schema.properties
      .file_to_upload as Record<string, unknown>;
    expect(field.type).toBe("string");
  });

  it("stages workspace file paths into Composio { name, mimetype, s3key } descriptors", async () => {
    const content = new TextEncoder().encode("hello drive");
    const { workspaceFiles } = makeWorkspaceFiles({
      "attachments/bao-cao.pdf": { bytes: content, mimeType: "application/pdf" },
    });
    const uploaded: Array<{
      name: string;
      type: string;
      size: number;
      toolSlug: string;
      toolkitSlug: string;
    }> = [];

    const staged = await stageComposioUploadArgs({
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      toolkitSlug: "googledrive",
      args: { file_to_upload: "attachments/bao-cao.pdf", folder_id: "root" },
      fileFields: new Set(["file_to_upload"]),
      workspaceFiles,
      uploadFile: async ({ file, toolSlug, toolkitSlug }) => {
        uploaded.push({
          name: file.name,
          type: file.type,
          size: file.size,
          toolSlug,
          toolkitSlug,
        });
        return {
          name: file.name,
          mimetype: file.type,
          s3key: "s3/staged/bao-cao.pdf",
        };
      },
    });

    expect(uploaded).toEqual([
      {
        name: "bao-cao.pdf",
        type: "application/pdf",
        size: content.byteLength,
        toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
        toolkitSlug: "googledrive",
      },
    ]);
    expect(staged).toEqual({
      file_to_upload: {
        name: "bao-cao.pdf",
        mimetype: "application/pdf",
        s3key: "s3/staged/bao-cao.pdf",
      },
      folder_id: "root",
    });
  });

  it("passes already-staged s3key descriptors through without re-uploading", async () => {
    const { workspaceFiles } = makeWorkspaceFiles({});
    const uploadFile = vi.fn();
    const existing = { name: "a.pdf", mimetype: "application/pdf", s3key: "already-uploaded" };

    const staged = await stageComposioUploadArgs({
      toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      toolkitSlug: "googledrive",
      args: { file_to_upload: existing },
      fileFields: new Set(["file_to_upload"]),
      workspaceFiles,
      uploadFile,
    });

    expect(staged.file_to_upload).toEqual(existing);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(workspaceFiles.readFile).not.toHaveBeenCalled();
  });

  it("throws a clear error when workspaceFiles is unavailable for a file upload", async () => {
    await expect(
      stageComposioUploadArgs({
        toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
        toolkitSlug: "googledrive",
        args: { file_to_upload: "attachments/report.pdf" },
        fileFields: new Set(["file_to_upload"]),
        workspaceFiles: undefined,
        uploadFile: vi.fn(),
      }),
    ).rejects.toThrow(/workspace/i);
  });

  it("downloads s3url file results into workspace downloads/ and attaches workspace_path", async () => {
    const { workspaceFiles, written } = makeWorkspaceFiles({});
    const bytes = new TextEncoder().encode("downloaded-body");
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));

    const result = await stageComposioDownloadResults({
      data: {
        file: {
          name: "invoice.pdf",
          s3url: "https://files.example.test/signed/invoice.pdf",
        },
      },
      workspaceFiles,
      signal: new AbortController().signal,
      fetchImpl,
      resolve: publicResolve,
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.fileName).toBe("invoice.pdf");
    expect(new TextDecoder().decode(written[0]?.content)).toBe("downloaded-body");
    expect(result).toEqual({
      file: {
        name: "invoice.pdf",
        s3url: "https://files.example.test/signed/invoice.pdf",
        workspace_path: "downloads/invoice.pdf",
      },
    });
  });

  it("keeps original payload when s3url download fails, uses non-https, or resolves to private IP", async () => {
    const { workspaceFiles, written } = makeWorkspaceFiles({});
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));

    const data = {
      failed: { name: "a.bin", s3url: "https://files.example.test/a.bin" },
      insecure: { name: "b.bin", s3url: "http://127.0.0.1/secret" },
    };
    const result = await stageComposioDownloadResults({
      data,
      workspaceFiles,
      signal: new AbortController().signal,
      fetchImpl,
      resolve: publicResolve,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(0);
    expect(result).toEqual(data);

    const ssrfFetch = vi.fn(async () => new Response("secret", { status: 200 }));
    const ssrfResult = await stageComposioDownloadResults({
      data: { internal: { name: "c.bin", s3url: "https://internal.example.test/c.bin" } },
      workspaceFiles,
      signal: new AbortController().signal,
      fetchImpl: ssrfFetch,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(ssrfFetch).not.toHaveBeenCalled();
    expect(ssrfResult).toEqual({
      internal: { name: "c.bin", s3url: "https://internal.example.test/c.bin" },
    });
  });
});
