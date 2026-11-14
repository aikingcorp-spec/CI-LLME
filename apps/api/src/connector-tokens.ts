/** Process memory only. A restart asks the control plane for the token again. */
export function createConnectorTokenHold() {
  const tokens = new Map<string, string>();
  return {
    put(objectId: string, token: string) {
      tokens.set(objectId, token);
    },
    get(objectId: string) {
      return tokens.get(objectId);
    },
    delete(objectId: string) {
      tokens.delete(objectId);
    },
  };
}
