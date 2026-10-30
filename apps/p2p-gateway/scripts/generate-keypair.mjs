// Prints a fresh Ed25519 key pair as raw 32-byte base64url values (the JWK `x` and `d`).
// Use it for the gateway key and for the app token key. Redirect the output to a 0600 file
// outside the repository, then delete it once the private half is stored as a secret.
import { generateKeyPairSync } from "node:crypto";

const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
process.stdout.write(`PUBLIC_KEY=${jwk.x}\nPRIVATE_KEY=${jwk.d}\n`);
