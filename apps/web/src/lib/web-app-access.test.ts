import { WEB_APP_NOT_INCLUDED } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { noteWebAppAccess, subscribeWebAppRefusal, webAppRefused } from "./web-app-access";

const reply = (status: number, code: string) =>
  new Response(JSON.stringify({ json: { defined: false, code, status } }), { status });

it("turns to the desktop-only page only when the server refuses the web app", async () => {
  const changed = vi.fn();
  subscribeWebAppRefusal(changed);
  await noteWebAppAccess(reply(403, "FORBIDDEN"));
  await noteWebAppAccess(reply(401, WEB_APP_NOT_INCLUDED));
  await noteWebAppAccess(new Response("not json", { status: 403 }));
  expect(webAppRefused()).toBe(false);
  const refused = reply(403, WEB_APP_NOT_INCLUDED);
  await noteWebAppAccess(refused);
  expect(webAppRefused()).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  // The caller still reads its own reply.
  expect(await refused.json()).toMatchObject({ json: { code: WEB_APP_NOT_INCLUDED } });
});
