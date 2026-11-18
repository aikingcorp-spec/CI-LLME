import {
  getPage,
  listPages,
  pinPage,
  removePage,
  renamePage,
  setPageVisibility,
} from "../pages.js";
import type { RouterContext } from "./context.js";

function remoteZoneFromPortal(portalOrigin: string | undefined): string | null {
  if (!portalOrigin) return null;
  try {
    const url = new URL(portalOrigin);
    if (url.protocol !== "https:") return null;
    return url.hostname.startsWith("app.") ? url.hostname.slice(4) : url.hostname;
  } catch {
    return null;
  }
}

async function resolveShareWebOrigin(deps: RouterContext["deps"]): Promise<string> {
  const zone = remoteZoneFromPortal(deps.env.remotePortalOrigin);
  if (!deps.localDeviceId || !deps.remoteRegistry || !zone) return deps.env.webOrigin;
  const listed = await deps.remoteRegistry.list().catch(() => undefined);
  const device = listed?.portal.devices.find((item) => item.deviceId === deps.localDeviceId);
  if (!device?.remoteEnabled || !/^h[a-f0-9]{32}$/.test(device.logicalHost)) {
    return deps.env.webOrigin;
  }
  return `https://${device.logicalHost}.${zone}`;
}

export function pagesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const pageDeps = async (withPublicLink = false) => ({
    prisma: deps.prisma,
    secrets: deps.secrets,
    webOrigin: withPublicLink ? await resolveShareWebOrigin(deps) : deps.env.webOrigin,
  });
  return {
    pages: {
      list: authed.pages.list.handler(({ context, input }) =>
        listPages(deps.prisma, context.actor, input),
      ),
      get: authed.pages.get.handler(async ({ context, input }) =>
        getPage(await pageDeps(Boolean(input.link)), context.actor, input),
      ),
      rename: authed.pages.rename.handler(({ context, input }) =>
        renamePage(deps.prisma, context.actor, input.pageId, input.title),
      ),
      setVisibility: authed.pages.setVisibility.handler(async ({ context, input }) =>
        setPageVisibility(
          await pageDeps(input.visibility === "link"),
          context.actor,
          input,
          context.signal ?? new AbortController().signal,
        ),
      ),
      pin: authed.pages.pin.handler(({ context, input }) =>
        pinPage(deps.prisma, context.actor, input.pageId, input.pinned),
      ),
      remove: authed.pages.remove.handler(async ({ context, input }) =>
        removePage(await pageDeps(false), context.actor, input.pageId),
      ),
    },
  };
}
