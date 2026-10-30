import { describe, expect, it } from "vitest";
import { DOWNLOAD_URL } from "../src/site";
import { fetchDownload, GET } from "./download";

describe("download redirect", () => {
  it("redirects to the configured download page", () => {
    const response = fetchDownload();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(DOWNLOAD_URL);
  });

  it("serves the redirect on GET", () => {
    expect(GET().headers.get("Location")).toBe(DOWNLOAD_URL);
  });
});
