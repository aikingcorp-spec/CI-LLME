/** Parse the local API session at the process boundary before binding a paired machine. */
export async function localP2PUser(response: Response): Promise<{ id: string; email: string }> {
  const result: unknown = await response.json();
  if (
    !response.ok ||
    !result ||
    typeof result !== "object" ||
    !("user" in result) ||
    !result.user ||
    typeof result.user !== "object" ||
    !("id" in result.user) ||
    !("email" in result.user) ||
    typeof result.user.id !== "string" ||
    typeof result.user.email !== "string"
  )
    throw new Error("Local session unavailable");
  return { id: result.user.id, email: result.user.email };
}
