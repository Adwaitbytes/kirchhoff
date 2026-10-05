import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Queryable } from "@kirchhoff/indexer";
import { LAB_STEP_ORDER, isChainKey, type Address, type Bytes32, type LabConsoleLine, type LabRun, type LabStep, type LabStepKey, type TxRef } from "@kirchhoff/sdk";
import { ApiFailure } from "./errors.ts";

/**
 * Attack Lab (demo only). Spawns `pnpm --filter @kirchhoff/demo attack` and turns its stdout into LabRun steps.
 * Primary protocol: demo/src/events.ts StepEvent JSON lines on stdout
 *   {"label":"Testnet simulation","network","step","status":"started"|"ok"|"refused"|"failed"|"skipped","chain":"home","title","txHash","detail",...}
 * mapped onto the 7 PRD steps by DEMO_STEP below. Also accepted: lines prefixed with `KIRCHHOFF_LAB `:
 *   {"type":"step","key":"forge_release","state":"running"|"done"|"failed","note":"...","txs":[TxRef],"messageId":"0x.."}
 *   {"type":"attacker","address":"0x.."}   {"type":"incident","id":"0x.."}
 * Every other line is shown in the console verbatim (stderr as stderr; lines naming a revert as revert).
 */

export type LabConfig = {
  enabled: boolean;
  disabledReason: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  token: string;
  attacker: Address;
};

const PREFIX = "KIRCHHOFF_LAB ";
const ALIAS_CHAIN: Readonly<Record<string, string>> = {
  home: "ethereum-testnet-sepolia",
  arb: "ethereum-testnet-sepolia-arbitrum-1",
  base: "ethereum-testnet-sepolia-base-1",
};

/** demo/src/attack.ts step names -> PRD section 5 Flow B steps. */
const DEMO_STEP: Readonly<Record<string, readonly LabStepKey[]>> = {
  "forge-credit": ["forge_release"],
  breach: ["junction_search", "breach_written"],
  quarantine: ["quarantine_applied"],
  "refuse-ccip": ["ccip_refused"],
  "refuse-guard": ["guard_and_lending"],
  "refuse-borrow": ["guard_and_lending"],
  "loop-epoch": ["loop_confirmed"],
};
const MAX_CONSOLE = 400;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function txRef(v: unknown): TxRef | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isChainKey(o.chain) || typeof o.hash !== "string" || !HEX32.test(o.hash)) return null;
  return {
    chain: o.chain,
    hash: o.hash.toLowerCase() as `0x${string}`,
    block: typeof o.block === "string" && /^\d+$/.test(o.block) ? o.block : typeof o.block === "number" ? String(o.block) : "0",
    timestamp: typeof o.timestamp === "string" && !Number.isNaN(Date.parse(o.timestamp)) ? o.timestamp : new Date().toISOString(),
  };
}

export class LabRunner {
  private readonly cfg: LabConfig;
  private readonly db: Queryable;
  private current: LabRun | null = null;
  private child: ChildProcess | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(cfg: LabConfig, db: Queryable) {
    this.cfg = cfg;
    this.db = db;
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }
  get disabledReason(): string | null {
    return this.cfg.enabled ? null : this.cfg.disabledReason;
  }

  get(id: string): LabRun | null {
    return this.current?.id === id ? this.current : null;
  }

  async latest(): Promise<LabRun | null> {
    if (this.current) return this.current;
    const r = await this.db.query<{ run: LabRun }>("select run from lab_runs order by started_at desc limit 1");
    return r.rows[0]?.run ?? null;
  }

  async byId(id: string): Promise<LabRun | null> {
    if (this.current?.id === id) return this.current;
    const r = await this.db.query<{ run: LabRun }>("select run from lab_runs where id = $1", [id]);
    return r.rows[0]?.run ?? null;
  }

  start(): LabRun {
    if (!this.cfg.enabled) throw new ApiFailure(403, "LAB_DISABLED", this.cfg.disabledReason);
    if (this.current?.state === "running") throw new ApiFailure(409, "BAD_REQUEST", "A Kelp Replay is already running. Wait for it to finish.");
    const now = new Date().toISOString();
    const steps: LabStep[] = LAB_STEP_ORDER.map((key) => ({ key, state: "pending", startedAt: null, finishedAt: null, txs: [], note: null, messageId: null }));
    const run: LabRun = { id: randomUUID(), token: this.cfg.token, startedAt: now, finishedAt: null, state: "running", attacker: this.cfg.attacker, steps, console: [], incidentId: null };
    this.current = run;
    this.log("cmd", `$ ${[this.cfg.command, ...this.cfg.args].join(" ")}`);
    // The script inherits the server env (it needs the demo keys); nothing from env is ever echoed.
    const child = spawn(this.cfg.command, this.cfg.args, { cwd: this.cfg.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const timeout = setTimeout(() => {
      this.log("stderr", `Lab run exceeded ${Math.round(this.cfg.timeoutMs / 1000)}s and was stopped.`);
      child.kill("SIGTERM");
    }, this.cfg.timeoutMs);
    createInterface({ input: child.stdout }).on("line", (l) => {
      this.onLine(l, "stdout");
    });
    createInterface({ input: child.stderr }).on("line", (l) => {
      this.onLine(l, "stderr");
    });
    child.on("error", (e) => {
      this.log("stderr", `could not start the attack script: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      this.finish(code === 0 && run.steps.every((s) => s.state === "done") ? "succeeded" : "failed", code);
    });
    void this.persist();
    return run;
  }

  /** One demo StepEvent. Returns false when the line is not one. */
  private onDemoEvent(ev: Record<string, unknown>): boolean {
    const run = this.current;
    if (!run || typeof ev.step !== "string" || typeof ev.status !== "string") return false;
    const detail = typeof ev.detail === "object" && ev.detail !== null ? (ev.detail as Record<string, unknown>) : {};
    if (typeof detail.attacker === "string" && /^0x[0-9a-fA-F]{40}$/.test(detail.attacker)) run.attacker = detail.attacker.toLowerCase() as Address;
    if (typeof detail.incidentId === "string" && HEX32.test(detail.incidentId)) run.incidentId = detail.incidentId.toLowerCase() as Bytes32;
    const at = typeof ev.at === "string" && !Number.isNaN(Date.parse(ev.at)) ? ev.at : new Date().toISOString();
    const chainKey = typeof ev.chain === "string" ? (ALIAS_CHAIN[ev.chain] ?? ev.chain) : null;
    const tx = typeof ev.txHash === "string" && HEX32.test(ev.txHash) && chainKey !== null && isChainKey(chainKey) ? { chain: chainKey, hash: ev.txHash.toLowerCase() as `0x${string}`, block: "0", timestamp: at } : null;
    const title = typeof ev.title === "string" ? ev.title : ev.step;
    const reason = typeof ev.revertReason === "string" ? ` (${ev.revertReason})` : "";
    this.log(ev.status === "refused" ? "revert" : ev.status === "failed" ? "stderr" : "stdout", `[${ev.step}] ${ev.status}: ${title}${reason}`, tx);
    if (ev.step === "attack" && ev.status === "failed") for (const s of run.steps) if (s.state === "running") s.state = "failed";
    const keys = DEMO_STEP[ev.step] ?? [];
    keys.forEach((key, i) => {
      const step = run.steps.find((s) => s.key === key);
      if (!step) return;
      step.startedAt ??= at;
      if (ev.status === "started") {
        // "breach started" is the Junction search; breach_written starts with the first BREACH write.
        if (i === 0 && step.state === "pending") step.state = "running";
      } else if (ev.status === "failed") {
        step.state = "failed";
        step.finishedAt = at;
      } else {
        // guard_and_lending finishes only when both the Guard and the borrow refusals are in.
        const both = key !== "guard_and_lending" || step.txs.length + (tx ? 1 : 0) >= 2 || ev.step === "refuse-borrow";
        step.state = both ? "done" : "running";
        if (both) step.finishedAt = at;
      }
      if (tx && (ev.status !== "started" || i > 0) && !step.txs.some((t) => t.hash === tx.hash)) step.txs.push(tx);
      if (ev.status !== "started") step.note = `${title}${reason}`.slice(0, 200);
      if (key === "ccip_refused" && typeof detail.messageId === "string" && HEX32.test(detail.messageId)) step.messageId = detail.messageId.toLowerCase() as Bytes32;
    });
    this.schedulePersist();
    return true;
  }

  private onLine(line: string, stream: "stdout" | "stderr"): void {
    const run = this.current;
    if (!run) return;
    if (stream === "stdout" && line.startsWith("{")) {
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (this.onDemoEvent(ev)) return;
      } catch {
        // Not JSON: shown verbatim below.
      }
    }
    if (line.startsWith(PREFIX)) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
      } catch {
        this.log("stderr", "malformed KIRCHHOFF_LAB event ignored");
        return;
      }
      if (ev.type === "step" && typeof ev.key === "string" && (LAB_STEP_ORDER as readonly string[]).includes(ev.key)) {
        const step = run.steps.find((s) => s.key === (ev.key as LabStepKey));
        if (!step) return;
        const now = new Date().toISOString();
        if (ev.state === "running" || ev.state === "done" || ev.state === "failed") {
          if (ev.state === "running") step.startedAt ??= now;
          else {
            step.startedAt ??= now;
            step.finishedAt = now;
          }
          step.state = ev.state;
        }
        if (typeof ev.note === "string") step.note = ev.note.slice(0, 200);
        if (Array.isArray(ev.txs)) step.txs.push(...ev.txs.map(txRef).filter((t): t is TxRef => t !== null));
        if (typeof ev.messageId === "string" && HEX32.test(ev.messageId)) step.messageId = ev.messageId.toLowerCase() as Bytes32;
      } else if (ev.type === "attacker" && typeof ev.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(ev.address)) {
        run.attacker = ev.address.toLowerCase() as Address;
      } else if (ev.type === "incident" && typeof ev.id === "string" && HEX32.test(ev.id)) {
        run.incidentId = ev.id.toLowerCase() as Bytes32;
      } else if (ev.type === "console" && typeof ev.text === "string") {
        const s = ev.stream === "revert" || ev.stream === "cmd" || ev.stream === "stderr" ? ev.stream : "stdout";
        this.log(s, ev.text, txRef(ev.tx));
        return;
      }
      this.schedulePersist();
      return;
    }
    this.log(/revert/i.test(line) ? "revert" : stream, line);
  }

  private log(stream: LabConsoleLine["stream"], text: string, tx: TxRef | null = null): void {
    const run = this.current;
    if (!run) return;
    run.console.push({ at: new Date().toISOString(), stream, text: text.slice(0, 500), tx });
    if (run.console.length > MAX_CONSOLE) run.console.splice(0, run.console.length - MAX_CONSOLE);
    this.schedulePersist();
  }

  private finish(state: "succeeded" | "failed", code: number | null): void {
    const run = this.current;
    if (!run) return;
    if (state === "failed") this.log("stderr", `attack script exited with code ${code ?? "null"}`);
    for (const s of run.steps) if (s.state === "running") s.state = "failed";
    run.state = state;
    run.finishedAt = new Date().toISOString();
    this.child = null;
    void this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 250);
  }

  private async persist(): Promise<void> {
    const run = this.current;
    if (!run) return;
    try {
      await this.db.query(
        `insert into lab_runs (id, token, state, run, started_at, finished_at) values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do update set state = excluded.state, run = excluded.run, finished_at = excluded.finished_at`,
        [run.id, run.token, run.state, JSON.stringify(run), run.startedAt, run.finishedAt],
      );
      await this.db.query("insert into stream_events (token_symbol, channel, ref) values ($1, 'lab', $2)", [run.token, JSON.stringify({ runId: run.id })]);
    } catch (e) {
      console.error("kirchhoff lab: persist failed", e instanceof Error ? e.message : e);
    }
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }
}
