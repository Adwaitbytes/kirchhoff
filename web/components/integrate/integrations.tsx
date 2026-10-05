"use client";

import { useState, type FormEvent } from "react";
import { setIssuerKey } from "@/lib/issuer-key";
import { ArrowUpRight, Bot, Code2, KeyRound, Plug, Radio, Terminal } from "lucide-react";
import type { ApiKeysResponse } from "@/lib/api/types";
import { API_URL, isApiError } from "@/lib/api/client";
import { useApi } from "@/lib/api/provider";
import { useTokens, useTokenStatus } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { readContractUrl } from "@/lib/explorer";
import { formatDateTime } from "@/lib/format";
import { Banner } from "@/components/kh/banner";
import { EmptyState, Panel, PanelHeader } from "@/components/kh/panel";
import { StatusWord } from "@/components/kh/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/integrate/code-block";
import { CopyButton } from "@/components/integrate/copy-button";

/** PRD section 13, verbatim. */
const SOLIDITY = `interface AggregatorV3Interface {
    function latestRoundData() external view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

abstract contract KirchhoffProtected {
    AggregatorV3Interface public immutable kirchhoffFeed; // ConservationFeed for this collateral
    uint256 public constant MAX_AGE = 300;                 // seconds

    error CollateralNotConserved(int256 status);
    error CollateralStatusStale(uint256 age);

    constructor(address feed) { kirchhoffFeed = AggregatorV3Interface(feed); }

    function _requireConserved() internal view {
        (, int256 s,, uint256 updatedAt,) = kirchhoffFeed.latestRoundData();
        if (block.timestamp - updatedAt > MAX_AGE) revert CollateralStatusStale(block.timestamp - updatedAt);
        if (s != 1 && s != 2) revert CollateralNotConserved(s); // 1 CONSERVED, 2 DRIFT
    }
}`;

/** PRD section 13, verbatim. */
const SDK = `import { Kirchhoff } from "@kirchhoff/sdk";
const k = new Kirchhoff({ network: "testnet" });
const s = await k.status("kETH");              // { status: "CONSERVED", delta: 0n, ... }
k.subscribe("kETH", (e) => console.log(e));     // live epochs, verdicts, incidents
const ok = await k.verifyOnchain("kETH", "ethereum-testnet-sepolia"); // reads the ledger directly via viem`;

const MCP_TOOLS = [
  ["kirchhoff_status", "token", "Status, Δ, age, per-chain summary"],
  ["kirchhoff_check_transfer", "token, src_chain, dst_chain, amount, sender", "would_pass, reason code, advice line"],
  ["kirchhoff_explain_verdict", "message_id", "Verdict, reason, evidence links"],
  ["kirchhoff_incident", "incident_id", "Narrative plus evidence"],
  ["kirchhoff_list_tokens", "none", "Protected tokens"],
] as const;

function mcpStdio(): string {
  return JSON.stringify(
    {
      mcpServers: {
        kirchhoff: {
          command: "npx",
          args: ["-y", "@kirchhoff/mcp", "--transport", "stdio"],
          env: { KIRCHHOFF_API_URL: API_URL },
        },
      },
    },
    null,
    2,
  );
}

function mcpHttp(): string {
  return JSON.stringify(
    {
      mcpServers: {
        kirchhoff: {
          type: "http",
          url: `${API_URL.replace(/\/v1\/?$/, "")}/mcp`,
        },
      },
    },
    null,
    2,
  );
}

function curlSnippets(): string {
  return `# Status, Δ, epoch, per-chain supply, pinned blocks, ledger addresses
curl -s ${API_URL}/tokens/kETH/status

# Dry run before a cross-chain move: would the verifier sign it?
curl -s -X POST ${API_URL}/check-transfer \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"kETH","srcChain":"ethereum-testnet-sepolia","dstChain":"ethereum-testnet-sepolia-base-1","amount":"10000000000000000000","sender":"0x0000000000000000000000000000000000000001"}'`;
}

function Section({ icon: Icon, title, lede, children, id }: { icon: typeof Plug; title: string; lede: string; children: React.ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-8">
      <div className="lg:pt-1">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-wire bg-raised shadow-[inset_0_1px_0_0_rgb(255_255_255/0.05)]">
            <Icon className="size-4 text-conserved" aria-hidden="true" />
          </span>
          <h2 id={id} className="text-base font-semibold tracking-[-0.01em]">
            {title}
          </h2>
        </div>
        <p className="mt-2 max-w-[38ch] text-sm leading-relaxed text-muted">{lede}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function FeedRows({ token }: { token: string }) {
  const q = useTokenStatus(token);
  if (q.isPending) {
    return (
      <li className="space-y-2 px-4 py-3" aria-hidden="true">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-full" />
      </li>
    );
  }
  if (q.error || !q.data) {
    return (
      <li className="px-4 py-3">
        <Banner tone="error">{token} feeds unavailable: {q.error?.message ?? "no data"}</Banner>
      </li>
    );
  }
  const s = q.data;
  return (
    <li className="px-4 py-3.5">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="text-sm font-semibold text-fg">{s.token.symbol}</span>
        <StatusWord status={s.token.status} className="text-xs" />
        <span className="ml-auto text-xs text-subtle">answer = status enum</span>
      </div>
      <ul className="space-y-2">
        {s.chains.map((c) => (
          <li key={c.chain} className="flex flex-col gap-2 rounded-md border border-wire bg-inset px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="w-36 shrink-0 text-xs text-muted">{CHAINS[c.chain].name}</span>
            <a
              href={readContractUrl(c.chain, c.contracts.feed)}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex min-w-0 items-center gap-1 font-mono text-xs text-fg hover:underline"
              aria-label={`ConservationFeed ${c.contracts.feed} on ${CHAINS[c.chain].name}, read latestRoundData`}
            >
              <span className="truncate">{c.contracts.feed}</span>
              <ArrowUpRight className="size-3 shrink-0 opacity-50 group-hover:opacity-100" aria-hidden="true" />
            </a>
            <CopyButton value={c.contracts.feed} label={`${s.token.symbol} feed address on ${CHAINS[c.chain].name}`} className="sm:ml-auto" />
          </li>
        ))}
      </ul>
    </li>
  );
}

function Feeds() {
  const tokens = useTokens();
  return (
    <Panel aria-label="Conservation feeds">
      <PanelHeader title="ConservationFeed" meta="AggregatorV3 compatible · one per token per chain" />
      {tokens.isPending ? (
        <div className="space-y-2 p-4" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : tokens.error ? (
        <div className="p-4">
          <Banner tone="error">Token list unreachable: {tokens.error.message}</Banner>
        </div>
      ) : tokens.data.items.length === 0 ? (
        <EmptyState title="No protected tokens yet. Onboard one to get its feeds." />
      ) : (
        <ul className="divide-y divide-wire/70">
          {tokens.data.items.map((t) => (
            <FeedRows key={t.symbol} token={t.symbol} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ApiKeys() {
  const api = useApi();
  const [key, setKey] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "ok"; data: ApiKeysResponse } | { kind: "error"; message: string; unauthorized: boolean }>({ kind: "idle" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setState({ kind: "loading" });
    try {
      setState({ kind: "ok", data: await api.listApiKeys(key.trim()) });
      setIssuerKey(key);
    } catch (err) {
      setState({ kind: "error", message: isApiError(err) ? err.message : "Key list unavailable", unauthorized: isApiError(err) && err.code === "UNAUTHORIZED" });
    }
  };

  return (
    <Panel aria-label="API keys">
      <PanelHeader title="API keys" meta="Issuer scope · Spec Copilot and backtests" />
      <form onSubmit={submit} className="flex flex-col gap-2 border-b border-wire p-4 sm:flex-row">
        <label htmlFor="issuer-key" className="sr-only">
          Issuer key
        </label>
        <input
          id="issuer-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Issuer key, kept in this tab only"
          className="h-9 min-w-0 flex-1 rounded-md border border-wire bg-inset px-3 font-mono text-sm text-fg shadow-[inset_0_1px_2px_rgb(0_0_0/0.2)] outline-none transition-colors placeholder:font-sans placeholder:text-subtle focus-visible:border-line-strong"
        />
        <Button type="submit" variant="secondary" disabled={!key.trim() || state.kind === "loading"}>
          <KeyRound aria-hidden="true" />
          {state.kind === "loading" ? "Checking" : "Show keys"}
        </Button>
      </form>
      {state.kind === "idle" ? (
        <EmptyState icon={<KeyRound className="size-5" />} title="Enter the issuer key to list API keys. It never leaves this tab." />
      ) : state.kind === "loading" ? (
        <div className="space-y-2 p-4" aria-hidden="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : state.kind === "error" ? (
        <div className="p-4">
          <Banner tone={state.unauthorized ? "warn" : "error"}>{state.unauthorized ? "Key rejected. Check the issuer key and try again." : state.message}</Banner>
        </div>
      ) : state.data.items.length === 0 ? (
        <EmptyState title="No API keys yet. Create one with POST /keys." />
      ) : (
        <ul className="divide-y divide-wire/70">
          {state.data.items.map((k) => (
            <li key={k.id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{k.label}</p>
                <p className="font-mono text-xs text-muted">{k.prefix}••••••••</p>
              </div>
              <div className="flex flex-wrap gap-1.5 sm:ml-auto">
                {k.scopes.map((s) => (
                  <span key={s} className="rounded border border-wire bg-inset px-1.5 py-0.5 font-mono text-2xs text-muted">
                    {s}
                  </span>
                ))}
              </div>
              <p className="text-xs text-subtle sm:w-44 sm:text-right">{k.lastUsedAt ? `Used ${formatDateTime(k.lastUsedAt)}` : "Never used"}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function Integrations() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="relative overflow-hidden border-b border-wire px-4 py-8 sm:px-8 sm:py-10">
        <div aria-hidden="true" className="pointer-events-none absolute -top-24 right-[-10%] h-64 w-[520px] rounded-full opacity-60 blur-3xl" style={{ background: "radial-gradient(closest-side, color-mix(in oklab, var(--status-conserved) 22%, transparent), transparent)" }} />
        <div aria-hidden="true" className="schematic-grid pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <div className="relative">
          <h1 className="font-display text-xl leading-none">Tap the current</h1>
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-muted">
            Three taps on one truth. The onchain feed is the source; HTTP and MCP mirror it. Every response names the ledger and block it read.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            {["Onchain feed · trustless", "REST · fast", "MCP · for agents"].map((t) => (
              <span key={t} className="rounded-full border border-wire bg-panel/70 px-3 py-1 text-muted shadow-panel backdrop-blur">
                {t}
              </span>
            ))}
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-[1200px] space-y-12 px-4 py-8 sm:px-8 sm:py-10">
        <Section id="feeds" icon={Radio} title="Feeds" lede="Read status like a price feed. Answer 1 is CONSERVED, 2 is DRIFT, 3 and up is a breach.">
          <Feeds />
        </Section>
        <Section id="solidity" icon={Code2} title="Guard your market" lede="Inherit KirchhoffProtected and call _requireConserved() before a borrow or a mint. Stale or broken collateral reverts.">
          <CodeBlock code={SOLIDITY} lang="solidity" title="KirchhoffProtected.sol" testId="solidity-snippet" />
        </Section>
        <Section id="rest" icon={Terminal} title="REST and SDK" lede="Public reads, rate-limited dry runs. Responses carry source onchain-mirror, the ledger address and the block.">
          <Tabs defaultValue="curl">
            <TabsList label="Client" className="mb-3">
              <TabsTrigger value="curl">curl</TabsTrigger>
              <TabsTrigger value="sdk">TypeScript SDK</TabsTrigger>
            </TabsList>
            <TabsContent value="curl">
              <CodeBlock code={curlSnippets()} lang="bash" title="REST quickstart" />
            </TabsContent>
            <TabsContent value="sdk">
              <CodeBlock code={SDK} lang="ts" title="@kirchhoff/sdk" />
            </TabsContent>
          </Tabs>
        </Section>
        <Section id="mcp" icon={Bot} title="Agents via MCP" lede="Read-only tools. Agents call kirchhoff_check_transfer before any cross-chain move and stop when would_pass is false.">
          <div className="space-y-4">
            <Tabs defaultValue="stdio">
              <TabsList label="MCP transport" className="mb-3">
                <TabsTrigger value="stdio">stdio</TabsTrigger>
                <TabsTrigger value="http">Streamable HTTP</TabsTrigger>
              </TabsList>
              <TabsContent value="stdio">
                <CodeBlock code={mcpStdio()} lang="json" title="mcp.json · stdio" />
              </TabsContent>
              <TabsContent value="http">
                <CodeBlock code={mcpHttp()} lang="json" title="mcp.json · Streamable HTTP" />
              </TabsContent>
            </Tabs>
            <div className="panel overflow-hidden">
              <ul className="divide-y divide-wire/70">
                {MCP_TOOLS.map(([name, input, output]) => (
                  <li key={name} className="grid gap-1 px-4 py-2.5 text-xs sm:grid-cols-[14rem_1fr_1fr] sm:gap-4">
                    <span className="font-mono font-medium text-fg">{name}</span>
                    <span className="font-mono text-muted">{input}</span>
                    <span className="text-muted">{output}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>
        <Section id="keys" icon={KeyRound} title="API keys" lede="Issuer keys unlock Spec Copilot drafts and backtests. Public reads need no key.">
          <ApiKeys />
        </Section>
      </div>
    </div>
  );
}
