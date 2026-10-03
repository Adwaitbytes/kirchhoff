// POSTs a payload file to a Judge, signed exactly like the chainlink-ccv verifier (for smoke checks).
//   node scripts/post-signed.ts <url> <payload.json>   env: JUDGE_HMAC_API_KEY, JUDGE_HMAC_SECRET (unset: unsigned)
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const [url, file] = process.argv.slice(2);
if (url === undefined || file === undefined) throw new Error("usage: post-signed.ts <url> <payload.json>");
const body = readFileSync(file, "utf8").trim();
const headers: Record<string, string> = { "content-type": "application/json" };
const key = process.env.JUDGE_HMAC_API_KEY;
const secret = process.env.JUDGE_HMAC_SECRET;
if (key !== undefined && key !== "" && secret !== undefined && secret !== "") {
  const ts = String(Date.now());
  const parsed = new URL(url);
  const target = parsed.pathname + parsed.search;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  headers.authorization = key;
  headers["x-authorization-timestamp"] = ts;
  headers["x-authorization-signature-sha256"] = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`POST ${target} ${bodyHash} ${key} ${ts}`)
    .digest("hex");
}
const started = performance.now();
const res = await fetch(url, { method: "POST", headers, body });
process.stdout.write(`HTTP ${res.status} in ${(performance.now() - started).toFixed(1)}ms ${await res.text()}\n`);
