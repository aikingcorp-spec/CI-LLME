import * as z from "zod";

export const RemotePresenceStateSchema = z.enum(["off", "connecting", "ready", "offline", "error"]);

export const RemoteHostViewSchema = z.object({
  deviceId: z.string(),
  logicalHost: z.string(),
  remoteEnabled: z.boolean(),
  state: RemotePresenceStateSchema,
});

export const RemotePortalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open"),
    deviceId: z.string(),
    logicalHost: z.string(),
    devices: z.array(RemoteHostViewSchema),
  }),
  z.object({
    kind: z.literal("choose"),
    devices: z.array(RemoteHostViewSchema),
  }),
  z.object({
    kind: z.literal("unavailable"),
    devices: z.array(RemoteHostViewSchema),
  }),
]);

export type RemotePresenceState = z.infer<typeof RemotePresenceStateSchema>;
export type RemotePortal = z.infer<typeof RemotePortalSchema>;

export const RemoteHostCommandSchema = z.object({
  kind: z.enum([
    "registered",
    "enabled",
    "disabled",
    "moved",
    "occupied",
    "needs-confirmation",
    "pilot-full",
    "unregistered",
    "conflict",
  ]),
  changed: z.boolean(),
  interruptedDeviceId: z.string().optional(),
  holders: z.array(z.string()).optional(),
  portal: RemotePortalSchema,
});

export type RemoteHostCommand = z.infer<typeof RemoteHostCommandSchema>;

/** What the identity registry answers a signed host request with; the connector token is only for present/set. */
export const RemoteRegistryResponseSchema = RemoteHostCommandSchema.partial().extend({
  portal: RemotePortalSchema,
  connectorToken: z.string().min(1).optional(),
});

export const RemoteHostDeviceInput = z.object({
  deviceId: z.string().min(1).max(256),
});

export const RemoteHostSetInput = RemoteHostDeviceInput.extend({
  enabled: z.boolean(),
  confirmed: z.boolean().optional(),
});

export const RemoteHostHeartbeatInput = RemoteHostDeviceInput.extend({
  error: z.boolean().optional(),
});
