/**
 * `make wallet-keys` — generate the X25519 recipient keypair that seals
 * managed minting keys (docs/security-key-custody.md). Pure crypto, no DB.
 *
 * Split the halves across processes:
 *   WALLET_KEY_PUBLIC_KEY  → web (encrypt-only at import) AND worker (self-check + re-seal)
 *   WALLET_KEY_PRIVATE_KEY → worker ONLY — the single process that can decrypt.
 * Prefer `WALLET_KEY_PRIVATE_KEY_FILE=/run/secrets/...` on the worker so the
 * private half never sits in .env or `docker inspect`.
 */
import { generateWalletKeypair } from "@hoodmint/secrets";

function main(): void {
  const keys = generateWalletKeypair();
  console.log("Managed minting-key envelope keypair (X25519). Generate once; rotating requires");
  console.log("re-importing every managed key (or a worker re-seal pass while both pairs exist).");
  console.log("");
  console.log("# web + worker:");
  console.log(`WALLET_KEY_PUBLIC_KEY=${keys.publicKeyB64}`);
  console.log("# worker ONLY (never give this to the web container):");
  console.log(`WALLET_KEY_PRIVATE_KEY=${keys.privateKeyB64}`);
  console.log("");
  console.log("Tip: put the private half in a file and set WALLET_KEY_PRIVATE_KEY_FILE instead.");
}

main();
