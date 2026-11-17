// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { COMPUTER_PROVIDER_UNAVAILABLE_ERROR } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: null, showPlans: () => {} }),
}));

import { ComposerError } from "./composer-error";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  const filename = path.resolve("packages/i18n/locales/vi/messages.po");
  const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
    locale: "vi",
    sourceLocale: "en",
    filename,
  });
  i18n.load("en", {});
  i18n.load(
    "vi",
    Object.fromEntries(
      Object.entries(catalog).map(([id, entry]) => [id, entry.translation || entry.message || id]),
    ),
  );
  i18n.activate("vi");
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  i18n.activate("en");
});

function renderError(runError: string) {
  act(() => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onDismissError = vi.fn();
  const onOpenConnections = vi.fn();
  const onOpenModels = vi.fn();
  act(() => {
    root?.render(
      <ComposerError
        sendError={null}
        runError={runError}
        runErrorId="failed-run"
        onRunErrorPresented={() => {}}
        onOpenModels={onOpenModels}
        onOpenConnections={onOpenConnections}
        onOpenBilling={() => {}}
        onDismissError={onDismissError}
        textareaRef={createRef()}
      />,
    );
  });
  return { onDismissError, onOpenConnections, onOpenModels };
}

it("shows a saved server fault in Vietnamese and keeps dismiss", () => {
  const { onDismissError } = renderError("Internal server error");
  const error = container?.querySelector('[data-testid="composer-error"]');
  expect(error?.textContent).toContain("Đã có lỗi xảy ra. Hãy thử lại.");
  expect(error?.querySelector("details")?.open).toBe(false);
  expect(error?.querySelector("pre")?.textContent).toBe("Internal server error");
  const dismiss = error?.querySelector<HTMLButtonElement>('[data-testid="composer-error-dismiss"]');
  expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss error");
  act(() => dismiss?.click());
  expect(onDismissError).toHaveBeenCalledOnce();
});

it("opens redacted details for a rejected key and still offers the connection", () => {
  const { onOpenConnections } = renderError(
    'Headers.append: "Bearer example-key\nclient = Client(timeout=30)" is an invalid header value.',
  );
  const error = container?.querySelector('[data-testid="composer-error"]');
  expect(error?.textContent).toContain("từ chối khóa API");
  const action = error?.querySelector<HTMLButtonElement>('[data-testid="composer-error-action"]');
  expect(action?.textContent).toBe("Replace key");
  act(() => action?.click());
  expect(onOpenConnections).toHaveBeenCalledOnce();
  const details = error?.querySelector("details");
  act(() => details?.querySelector("summary")?.click());
  expect(details?.querySelector("pre")?.textContent).not.toContain("example-key");
  expect(details?.querySelector("pre")?.textContent).toContain("[redacted]");
});

it("does not offer a model change for a computer outage or a broken transcript", () => {
  renderError(COMPUTER_PROVIDER_UNAVAILABLE_ERROR);
  const computer = container?.querySelector('[data-testid="composer-error"]');
  expect(computer?.textContent).toContain("Máy tính của bot chưa sẵn sàng. Hãy thử lại sau.");
  expect(computer?.querySelector('[data-testid="composer-error-action"]')).toBeNull();

  renderError("Unmatched tool result in context");
  const transcript = container?.querySelector('[data-testid="composer-error"]');
  expect(transcript?.textContent).toContain(
    "Ngữ cảnh trò chuyện bị lỗi. Hãy thử lại hoặc bắt đầu cuộc trò chuyện mới.",
  );
  expect(transcript?.textContent).not.toContain("Nhà cung cấp mô hình trả về lỗi.");
  expect(transcript?.querySelector('[data-testid="composer-error-action"]')).toBeNull();
});
