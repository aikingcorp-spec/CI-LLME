import { useSyncExternalStore } from "react";

export type RemoteEdition = "free" | "team";

let currentEdition: RemoteEdition | undefined;
const listeners = new Set<() => void>();

export function getRemoteEdition(): RemoteEdition | undefined {
  return currentEdition;
}

export function setRemoteEdition(edition: RemoteEdition | undefined): void {
  if (currentEdition === edition) return;
  currentEdition = edition;
  for (const listener of listeners) listener();
}

export function subscribeRemoteEdition(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRemoteEdition(): RemoteEdition | undefined {
  return useSyncExternalStore(subscribeRemoteEdition, getRemoteEdition, () => undefined);
}
