/**
 * `make vapid-keys` — generate a one-time VAPID keypair for the Web Push
 * alert channel (feature-backlog.md, shipped 2026-08-22). Pure crypto, no
 * DB needed — run once, put the output in .env, keep it forever (rotating
 * the keypair invalidates every existing browser subscription, which
 * would then need to re-subscribe).
 */
import webpush from "web-push";

function main(): void {
  const keys = webpush.generateVAPIDKeys();
  console.log("VAPID keypair (generate once, keep forever — rotating invalidates every");
  console.log("existing push subscription). Add these to .env:");
  console.log("");
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
  console.log("VAPID_SUBJECT=mailto:you@example.com  # or an https:// URL identifying you");
  console.log("");
  console.log("VAPID_PUBLIC_KEY is also read by the browser to subscribe — it is not a secret by");
  console.log(
    "design (RFC 8292's whole point is that only the private key must stay confidential).",
  );
}

main();
