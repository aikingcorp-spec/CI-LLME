import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

let registered = false;

/**
 * Registers OAuth flows and Bedrock streaming statically for bundled server builds where
 * dynamic specifier imports inside `@earendil-works/pi-ai` cannot resolve chunk files by name.
 */
export function registerPiBundledModules(): void {
  if (registered) return;
  registered = true;
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
}
