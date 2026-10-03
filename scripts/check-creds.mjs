#!/usr/bin/env node
// Prints a green/red table of every credential KIRCHHOFF needs, with a live probe where one is cheap.
// Never prints secret values.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";

const env = { ...loadDotenv(".env"), ...process.env };

const CHAINS = [
  { key: "ETH_SEPOLIA", name: "Ethereum Sepolia", chainId: 11155111, minWei: 2n * 10n ** 16n },
  { key: "ARB_SEPOLIA", name: "Arbitrum Sepolia", chainId: 421614, minWei: 3n * 10n ** 15n },
  { key: "BASE_SEPOLIA", name: "Base Sepolia", chainId: 84532, minWei: 3n * 10n ** 15n },
];

const rows = [];
const add = (group, item, ok, detail, required = true) => rows.push({ group, item, ok, detail, required });

function loadDotenv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "") out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return "invalid url"; }
}

function cmd(bin, args) {
  try { return { ok: true, out: execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).toString().trim() }; }
  catch (e) { return { ok: false, out: (e.stderr?.toString() || e.message).trim().split("\n")[0] }; }
}

// Validates the key is a real secp256k1 scalar; balances are probed via DEPLOYER_ADDRESS written by `make wallets`.
function validKey(k) {
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) return false;
  try {
    const der = Buffer.concat([Buffer.from("302e0201010420", "hex"), Buffer.from(k.slice(2), "hex"), Buffer.from("a00706052b8104000a", "hex")]);
    createPrivateKey({ key: der, format: "der", type: "sec1" });
    return true;
  } catch { return false; }
}

async function main() {
  for (const k of ["DEPLOYER_PRIVATE_KEY", "ATTACKER_PRIVATE_KEY", "WEAKBRIDGE_VERIFIER_PRIVATE_KEY", "SAFE_SIGNER_1_PRIVATE_KEY", "SAFE_SIGNER_2_PRIVATE_KEY", "SAFE_SIGNER_3_PRIVATE_KEY"]) {
    add("Wallets", k, validKey(env[k]), validKey(env[k]) ? "valid secp256k1 key" : "missing or malformed");
  }

  const deployer = env.DEPLOYER_ADDRESS;
  for (const c of CHAINS) {
    const urls = [env[`RPC_${c.key}_1`], env[`RPC_${c.key}_2`]];
    const hosts = new Set();
    for (const [i, url] of urls.entries()) {
      const item = `RPC_${c.key}_${i + 1}`;
      if (!url) { add("RPC", item, false, "missing"); continue; }
      try {
        const id = parseInt(await rpc(url, "eth_chainId"), 16);
        hosts.add(hostOf(url).split(".").slice(-2).join("."));
        add("RPC", item, id === c.chainId, id === c.chainId ? `${hostOf(url)} chainId ${id}` : `wrong chainId ${id}`);
      } catch (e) { add("RPC", item, false, `${hostOf(url)}: ${e.message}`); }
    }
    add("RPC", `${c.name} providers independent`, hosts.size === 2, hosts.size === 2 ? [...hosts].join(" + ") : "both RPCs share one provider");
    const probe = urls.find(Boolean);
    if (deployer && probe) {
      try {
        const wei = BigInt(await rpc(probe, "eth_getBalance", [deployer, "latest"]));
        const eth = Number(wei / 10n ** 14n) / 1e4;
        add("Funds", `Deployer ETH on ${c.name}`, wei >= c.minWei, `${eth} ETH (need >= ${Number(c.minWei / 10n ** 14n) / 1e4})`);
      } catch (e) { add("Funds", `Deployer ETH on ${c.name}`, false, e.message); }
    } else {
      add("Funds", `Deployer ETH on ${c.name}`, false, deployer ? "no RPC configured" : "run `make wallets`");
    }
  }

  if (env.ETHERSCAN_API_KEY) {
    try {
      const r = await fetch(`https://api.etherscan.io/v2/api?chainid=11155111&module=proxy&action=eth_blockNumber&apikey=${env.ETHERSCAN_API_KEY}`, { signal: AbortSignal.timeout(8000) });
      const b = await r.json();
      add("Explorers", "ETHERSCAN_API_KEY", Boolean(b.result && b.result.startsWith("0x")), b.result?.startsWith("0x") ? "Etherscan V2 key works" : String(b.result || b.message));
    } catch (e) { add("Explorers", "ETHERSCAN_API_KEY", false, e.message); }
  } else add("Explorers", "ETHERSCAN_API_KEY", false, "missing");

  if (env.OPENROUTER_API_KEY) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(8000) });
      const b = r.ok ? await r.json() : null;
      add("AI", "OPENROUTER_API_KEY", r.ok, r.ok ? `key works, $${b.data.limit_remaining?.toFixed(2)} left, model=${env.OPENROUTER_MODEL}` : `HTTP ${r.status}`, false);
    } catch (e) { add("AI", "OPENROUTER_API_KEY", false, e.message, false); }
  } else if (env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(8000) });
      add("AI", "ANTHROPIC_API_KEY", r.ok, r.ok ? `key works, model=${env.ANTHROPIC_MODEL}` : `HTTP ${r.status}`, false);
    } catch (e) { add("AI", "ANTHROPIC_API_KEY", false, e.message, false); }
  } else add("AI", "AI provider key", false, "missing (AI falls back to deterministic templates)", false);

  const cre = cmd("cre", ["whoami"]);
  add("Chainlink CRE", "cre CLI login", cre.ok, cre.ok ? cre.out.split("\n")[0] : "run `cre login`");
  add("Chainlink CRE", "CRE live deploy access", env.CRE_DEPLOY_MODE === "live", env.CRE_DEPLOY_MODE === "live" ? "live" : "simulate (ask mentors, see HUMAN_TASKS.md)", false);

  const gh = cmd("gh", ["auth", "status"]);
  add("Deploy", "GitHub (gh auth)", gh.ok, gh.ok ? "logged in" : gh.out);
  const vc = cmd("vercel", ["whoami"]);
  add("Deploy", "Vercel CLI login", vc.ok, vc.ok ? vc.out.split("\n").pop() : vc.out);
  add("Deploy", "VERCEL_TOKEN (CI deploys)", Boolean(env.VERCEL_TOKEN), env.VERCEL_TOKEN ? "present" : "missing (local CLI deploys still work)", false);

  const dbOk = Boolean(env.DATABASE_URL);
  add("Data", "DATABASE_URL", dbOk, dbOk ? hostOf(env.DATABASE_URL.replace(/^postgres(ql)?:/, "http:")) : "missing");
  add("Secrets", "JUDGE_HMAC_SECRET", (env.JUDGE_HMAC_SECRET || "").length >= 32, env.JUDGE_HMAC_SECRET ? "present" : "run `make secrets`");

  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(8000) });
      add("Notifier", "TELEGRAM_BOT_TOKEN", r.ok, r.ok ? "bot token works" : `HTTP ${r.status}`, false);
    } catch (e) { add("Notifier", "TELEGRAM_BOT_TOKEN", false, e.message, false); }
  } else add("Notifier", "TELEGRAM_BOT_TOKEN", false, "missing (optional)", false);
  add("Notifier", "TELEGRAM_CHAT_ID", Boolean(env.TELEGRAM_CHAT_ID), env.TELEGRAM_CHAT_ID ? "present" : "missing (optional)", false);
  add("Notifier", "SLACK_WEBHOOK_URL", /^https:\/\/hooks\.slack\.com\//.test(env.SLACK_WEBHOOK_URL || ""), env.SLACK_WEBHOOK_URL ? "present" : "missing (optional)", false);

  const docker = cmd("docker", ["info", "--format", "{{.ServerVersion}}"]);
  add("Infra", "Docker daemon (k3d cell, Postgres)", docker.ok, docker.ok ? `server ${docker.out}` : docker.out);
  add("Infra", "Cloud VM for k3s", Boolean(env.CCV_VM_SSH), env.CCV_VM_SSH ? env.CCV_VM_SSH.split("@").pop() : "none, using local k3d", false);

  print();
  const missing = rows.filter((r) => r.required && !r.ok).length;
  process.exitCode = missing ? 1 : 0;
}

function print() {
  const tty = process.stdout.isTTY;
  const g = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
  const r = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
  const y = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
  const w1 = Math.max(...rows.map((x) => x.group.length));
  const w2 = Math.max(...rows.map((x) => x.item.length));
  let group = "";
  for (const row of rows) {
    if (row.group !== group) { group = row.group; console.log(""); }
    const mark = row.ok ? g("  OK  ") : row.required ? r(" MISS ") : y(" OPT  ");
    console.log(`${mark} ${row.group.padEnd(w1)}  ${row.item.padEnd(w2)}  ${row.detail}`);
  }
  const req = rows.filter((x) => x.required);
  console.log(`\n${req.filter((x) => x.ok).length}/${req.length} required credentials ready.`);
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
