"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Cpu, FlaskConical, Lock, OctagonX, Radio, ScanSearch, ShieldCheck, Sigma, X, Zap } from "lucide-react";
import { useNow, useTokenStatus, useTokens } from "@/lib/api/hooks";
import { CHAINS } from "@/lib/chains";
import { escrowBalanceUrl, tokenUrl } from "@/lib/explorer";
import { StatusWord } from "@/components/kh/status";
import { Verifiable } from "@/components/kh/links";
import { JunctionScene } from "@/components/landing/junction-scene";
import { formatAge, formatAmount, parseWei, secondsBetween } from "@/lib/format";
import { STATUS_STYLE, hasEpoch } from "@/lib/status";
import { Enter, Reveal } from "@/components/landing/reveal";
import { CurrentField } from "@/components/landing/current-field";
import { LandingNav } from "@/components/landing/landing-nav";
import { SimulationLabel } from "@/components/kh/simulation";
import { ArchitectureDiagram, JunctionVisual, LiveCircuit, LoopVisual, ReplayStrip } from "@/components/landing/sections";
import { LogoMark, Wordmark } from "@/components/shell/logo";
import { cn } from "@/lib/utils";

const SOURCES = {
  kelp: "https://www.cryptotimes.io/2026/05/18/crypto-bridge-hacks-top-328m-in-2026-as-cross-chain-exploits-accelerate/",
  verifier: "https://decrypt.co/379463",
  chains: "https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained",
  total: "https://www.dextools.io/news/crypto-bridge-hacks-340-million-2026-peckshield-alert-june-2026-de",
  ccip: "https://chain.link/blog/introducing-ccip-2-0",
};

function LiveStatus() {
  const tokens = useTokens();
  const now = useNow();
  const t = tokens.data?.items[0];
  if (tokens.isPending) return <div className="skeleton h-11 w-[340px] max-w-full rounded-full" aria-hidden="true" />;
  if (!t) {
    return (
      <span className="inline-flex h-11 items-center gap-2 rounded-full border border-wire bg-panel/70 px-4 text-sm text-muted">
        <Radio className="size-4" aria-hidden="true" />
        {tokens.error ? "Live status offline · the onchain feed still answers" : "No protected tokens yet"}
      </span>
    );
  }
  const s = STATUS_STYLE[t.status];
  const Icon = s.icon;
  const age = now === 0 || !hasEpoch(t) ? null : secondsBetween(t.updatedAt, now);
  return (
    <Link
      href={`/t/${t.symbol}`}
      data-testid="landing-live-status"
      className={cn(
        "group inline-flex h-11 max-w-full items-center gap-3 rounded-full border bg-panel/70 pl-1.5 pr-4 text-sm shadow-panel backdrop-blur transition-[border-color,box-shadow] hover:shadow-pop",
        s.border,
      )}
    >
      <span className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-semibold tracking-[0.02em]", s.soft, s.text)}>
        <Icon className="size-4" aria-hidden="true" />
        {t.status}
      </span>
      <span className="truncate font-mono text-fg tnum">
        {hasEpoch(t) ? `${t.symbol} Δ ${formatAmount(parseWei(t.delta), { decimals: t.decimals, maxFraction: 0, signed: true })}` : t.symbol}
      </span>
      <span className="hidden truncate text-muted sm:inline">{!hasEpoch(t) ? "no epoch yet" : age === null ? "" : `checked ${formatAge(age)} ago`}</span>
      <ArrowUpRight className="size-4 shrink-0 text-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

/** DM Mono eyebrow with a hairline running to the right edge, like a schematic label. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-center gap-4" aria-hidden="true">
      <span className="eyebrow min-w-0 text-subtle">{children}</span>
      <span className="hidden h-px min-w-12 flex-1 bg-gradient-to-r from-wire to-transparent sm:block" />
    </div>
  );
}

function HeroScene() {
  const st = useTokenStatus("kETH");
  const data = st.data;
  const chains = data?.chains ?? [];
  return (
    <div className="relative mx-auto mt-6 grid w-full max-w-[1280px] lg:-mt-2 grid-cols-1 items-center gap-6 px-4 sm:mt-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.9fr)_minmax(0,0.8fr)] lg:gap-2">
      {/* Left: the attacker, slightly out of focus, like a figure behind glass. */}
      <aside
        aria-label="Attacker console, testnet simulation"
        className="group order-2 hidden rounded-[18px] border border-wire bg-panel/85 p-4 text-left shadow-pop backdrop-blur transition-[filter,opacity,transform] duration-500 lg:order-1 lg:block lg:opacity-95"
      >
        <span className="eyebrow block text-broken">Attacker · WeakBridge</span>
        <SimulationLabel className="mt-2" />
        <ul className="mt-3 space-y-1.5 font-mono text-[12px] leading-relaxed">
          <li className="text-muted"><span className="text-subtle">$</span> sign credit, 1 of 1 verifier</li>
          <li className="text-fg">Released 116,500 kETH on Sepolia</li>
          <li className="text-broken">✗ W1 finds no matching burn</li>
          <li className="text-broken">✗ Judge FAIL TOKEN_BROKEN</li>
          <li className="text-muted line-through decoration-broken/60">ccip send to Base Sepolia</li>
        </ul>
      </aside>

      <div className="order-1 lg:order-2">
        <JunctionScene className="mx-auto aspect-[1/1] w-full max-w-[880px] sm:aspect-[4/3]" />
        <div className="mt-1 flex justify-center">
          <LiveStatus />
        </div>
      </div>

      {/* Right: three chains with live supply; the farther ones sit back in focus. */}
      <div className="order-3 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1 lg:gap-3">
        {(chains.length ? chains : [null, null, null]).map((c, i) => (
          <div
            key={c?.chain ?? i}
            className={cn(
              "rounded-[18px] border border-wire bg-panel/85 p-3 text-left shadow-pop backdrop-blur transition-[filter,opacity,transform] duration-500 sm:p-4",
              "flex items-center justify-between gap-3 lg:block",
            )}
          >
            {c && data ? (
              <>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold text-fg">
                    <span className="lg:hidden">{CHAINS[c.chain].short}</span>
                    <span className="hidden lg:inline">{CHAINS[c.chain].name}</span>
                  </span>
                  <span className="hidden sm:inline">
                    <StatusWord status={c.ledgerStatus} className="text-2xs" />
                  </span>
                </div>
                <Verifiable
                  href={c.role === "home" && c.contracts.escrow ? escrowBalanceUrl(c.chain, c.contracts.token, c.contracts.escrow) : tokenUrl(c.chain, c.contracts.token)}
                  label={`${CHAINS[c.chain].name} ${c.role === "home" ? "escrow" : "supply"}`}
                  className="block font-mono text-[15px] text-fg sm:text-lg lg:mt-1.5"
                >
                  {formatAmount(parseWei(c.role === "home" && c.escrow !== null ? c.escrow : c.supply), { decimals: data.token.decimals, maxFraction: 0 })}
                </Verifiable>
                <span className="eyebrow mt-0.5 hidden text-[10px] text-subtle lg:block">{c.role === "home" ? "backing" : "supply"}</span>
              </>
            ) : (
              <div className="space-y-2" aria-hidden="true">
                <div className="skeleton h-3.5 w-2/3" />
                <div className="skeleton h-5 w-4/5" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative isolate flex min-h-[100svh] flex-col overflow-hidden pb-16" aria-labelledby="hero-title">
      <CurrentField variant="glow" focus={0.66} className="absolute inset-0 -z-10 h-full w-full" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46%] bg-[radial-gradient(60%_80%_at_50%_20%,var(--bg-base)_35%,transparent_85%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-32 bg-gradient-to-t from-canvas to-transparent" />

      <div className="mx-auto flex w-full max-w-[1160px] flex-col items-center px-5 pt-24 text-center sm:pt-28">
        <Enter>
          <Link
            href="/t/kETH"
            className="inline-flex items-center gap-2 rounded-full border border-wire bg-panel/80 px-3.5 py-1.5 font-mono text-[12px] tracking-[0.04em] text-muted shadow-panel backdrop-blur transition-colors hover:text-fg"
          >
            <span className="size-1.5 rounded-full bg-mint shadow-[0_0_8px_var(--mint)]" aria-hidden="true" />
            3 testnets<span className="hidden sm:inline"> · 2 bridges</span> · CCIP 2.0 verifier
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </Enter>
        <Enter delay={90}>
          <h1 id="hero-title" className="font-display mt-6 text-balance text-[clamp(34px,4.3vw,64px)] leading-[1.05] text-fg">
            Every bridge checks who signed
          </h1>
        </Enter>
        <Enter delay={180}>
          <p className="mt-4 max-w-[52ch] text-balance text-[clamp(18px,1.6vw,22px)] font-[450] leading-[1.4] tracking-[-0.015em] text-muted">
            KIRCHHOFF checks if the money adds up.{" "}
            <span className="text-fg">
              <span className="text-conserved">Conserved</span> signs. <span className="text-broken">Broken</span> never moves.
            </span>
          </p>
        </Enter>
        <Enter delay={240} className="mt-7 flex flex-col items-center gap-5">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/app"
                className="group inline-flex h-12 items-center gap-2 rounded-full bg-fg px-6 text-[15px] font-medium text-canvas shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(0_0_0/0.2)] transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_12px_28px_-10px_color-mix(in_oklab,var(--mint)_80%,transparent)]"
              >
                Open Mission Control
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </Link>
              <Link
                href="/lab"
                className="inline-flex h-12 items-center gap-2 rounded-full border border-line-strong bg-panel px-6 text-[15px] font-medium text-fg shadow-panel transition-[border-color,box-shadow] hover:border-broken/50 hover:shadow-pop"
              >
                <FlaskConical className="size-4 text-broken" aria-hidden="true" />
                Run the Kelp Replay
              </Link>
            </div>
          </Enter>
      </div>
      <Enter delay={300}>
        <HeroScene />
      </Enter>
  
    </section>
  );
}

function Stat({ value, label, href, source }: { value: string; label: string; href: string; source: string }) {
  return (
    <div className="border-t border-wire pt-5">
      <p className="font-num text-[clamp(28px,3vw,40px)] leading-none text-fg">{value}</p>
      <p className="mt-1.5 max-w-[26ch] text-[15px] leading-snug text-muted">{label}</p>
      <a href={href} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-subtle underline decoration-dotted underline-offset-4 hover:text-fg">
        {source}
        <ArrowUpRight className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

function Problem() {
  return (
    <section className="relative mx-auto max-w-[1160px] px-5 py-28 sm:py-36" aria-labelledby="problem-title">
      <div className="grid gap-14 lg:grid-cols-[1.25fr_1fr] lg:items-end">
        <Reveal>
          <h2 id="problem-title" className="eyebrow text-muted">
            One forged message
          </h2>
          <p className="font-num relative isolate mt-4 text-[clamp(72px,14vw,176px)] leading-[0.9] text-fg">
            <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 -inset-y-12 -z-10 bg-[radial-gradient(farthest-side,color-mix(in_oklab,var(--status-broken)_18%,transparent),transparent)]" />
            $292M
          </p>
          <p className="mt-6 max-w-[30ch] text-balance text-[clamp(22px,2.6vw,32px)] font-medium leading-[1.15] tracking-[-0.025em] text-fg">
            created from nothing. The bridge checked the signature. Nobody checked the sum
          </p>
          <a href={SOURCES.kelp} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-xs text-subtle underline decoration-dotted underline-offset-4 hover:text-fg">
            Kelp DAO, April 18 2026 · Crypto Times
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </a>
        </Reveal>
        <div className="grid gap-8 sm:grid-cols-3 lg:grid-cols-1">
          <Reveal delay={80}>
            <Stat value="1 of 1" label="verifier on the bridge that released 116,500 rsETH" href={SOURCES.verifier} source="Decrypt" />
          </Reveal>
          <Reveal delay={160}>
            <Stat value="20 chains" label="of rsETH holders hit without touching Kelp" href={SOURCES.chains} source="Phemex" />
          </Reveal>
          <Reveal delay={240}>
            <Stat value="$340M+" label="drained from bridges across 14 incidents in 2026" href={SOURCES.total} source="DexTools · PeckShield" />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function RuleCard({ icon: Icon, title, line, body, children, delay }: { icon: typeof Sigma; title: string; line: string; body: string; children: React.ReactNode; delay: number }) {
  return (
    <Reveal delay={delay} className="h-full">
      <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-wire bg-[linear-gradient(180deg,var(--panel-top),var(--bg-panel))] p-6 shadow-[inset_0_1px_0_0_var(--panel-highlight),var(--shadow-panel)] transition-[border-color,box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--status-conserved)_16%,transparent),transparent)] opacity-60 transition-opacity duration-500 group-hover:opacity-100" />
        <span className="flex size-10 items-center justify-center rounded-xl border border-wire bg-inset text-conserved">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <h3 className="font-display mt-6 text-[clamp(24px,2.4vw,32px)] leading-[1.1] text-fg">{title}</h3>
        <p className="mt-2 text-[17px] font-medium text-fg/90">{line}</p>
        <p className="mt-3 max-w-[48ch] text-[15px] leading-relaxed text-muted">{body}</p>
        <div className="mt-8 flex-1" />
        {children}
      </article>
    </Reveal>
  );
}

function Live() {
  return (
    <section id="live" className="relative mx-auto max-w-[1160px] scroll-mt-24 px-5 pb-8 pt-28 sm:pt-32" aria-labelledby="live-title">
      <Reveal>
        <Eyebrow>Live read · 3 testnets · every figure verifiable</Eyebrow>
        <h2 id="live-title" className="max-w-[18ch] font-display text-balance text-[clamp(32px,4.4vw,56px)] leading-[1.08] text-fg">
          Live on three testnets
        </h2>
        <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-muted">The same read model Mission Control runs on. Every figure opens its onchain read</p>
      </Reveal>
      <Reveal delay={120} className="mt-10">
        <LiveCircuit />
      </Reveal>
    </section>
  );
}

function Contrast() {
  const bridge = ["who signed the message", "whether the quorum was met", "whether the payload parses"];
  const ours = ["is there a debit for this credit", "does backing cover every claim", "does the token add up right now"];
  return (
    <div className="mt-12 grid overflow-hidden rounded-[18px] border border-wire bg-panel shadow-pop sm:grid-cols-2">
      <div className="border-b border-wire p-6 sm:border-b-0 sm:border-r sm:p-8">
        <p className="eyebrow text-subtle">A bridge asks</p>
        <ul className="mt-4 space-y-2.5">
          {bridge.map((b) => (
            <li key={b} className="flex items-center gap-2.5 text-[15px] text-muted">
              <Check className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              {b}
            </li>
          ))}
        </ul>
        <p className="mt-5 font-mono text-[12px] uppercase tracking-[0.14em] text-subtle line-through decoration-broken/70">enough to stop a forged credit</p>
      </div>
      <div className="relative p-6 sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-20 size-56 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--mint)_30%,transparent),transparent)]" />
        <p className="eyebrow text-conserved">KIRCHHOFF asks</p>
        <ul className="relative mt-4 space-y-2.5">
          {ours.map((b) => (
            <li key={b} className="flex items-center gap-2.5 text-[15px] font-medium text-fg">
              <Sigma className="size-4 shrink-0 text-conserved" aria-hidden="true" />
              {b}
            </li>
          ))}
        </ul>
        <p className="relative mt-5 font-mono text-[12px] uppercase tracking-[0.14em] text-conserved">no, or no signature</p>
      </div>
    </div>
  );
}

function Rules() {
  return (
    <section id="rules" className="relative scroll-mt-24 border-y border-wire/60 bg-[linear-gradient(180deg,transparent,color-mix(in_oklab,var(--bg-panel)_55%,transparent)_30%,transparent)] py-28 sm:py-36" aria-labelledby="rules-title">
      <div className="mx-auto max-w-[1160px] px-5">
        <Reveal>
          <Eyebrow>The two laws · junction · loop</Eyebrow>
          <h2 id="rules-title" className="max-w-[18ch] font-display text-balance text-[clamp(32px,4.4vw,56px)] leading-[1.08] text-fg">
            Two laws, one circuit
          </h2>
          <p className="mt-5 max-w-[58ch] text-[17px] leading-relaxed text-muted">
            Borrowed from Kirchhoff&apos;s circuit laws. Chains are nodes, bridges are wires, money is current. When the current stops adding up, the circuit opens.
          </p>
        </Reveal>
        <Contrast />
        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          <RuleCard icon={Zap} delay={60} title="Junction Rule" line="Every credit needs its debit" body="A mint or release must match a finalized burn or lock with the same message id, amount and recipient. A credit with no debit is forged, caught on the first transaction.">
            <JunctionVisual />
          </RuleCard>
          <RuleCard icon={Sigma} delay={160} title="Loop Rule" line="Backing covers every claim" body="Each epoch, the Conservation Engine reads every chain at pinned blocks with DON consensus. Escrow must cover remote supply plus everything in flight, whichever path minted it.">
            <LoopVisual />
          </RuleCard>
        </div>
      </div>
    </section>
  );
}

const BEATS = [
  { icon: FlaskConical, title: "Forge", line: "One verifier key signs a credit. 116,500 kETH leaves the escrow" },
  { icon: ScanSearch, title: "Detect", line: "W1 searches every remote chain for the burn. None exists" },
  { icon: OctagonX, title: "Break", line: "BROKEN lands on all three ledgers in the same CRE run" },
  { icon: Lock, title: "Contain", line: "CCIP lanes freeze, the attacker is tainted, the feed flips" },
  { icon: ShieldCheck, title: "Refuse", line: "The escape transfer to Base gets FAIL TOKEN_BROKEN. It never executes" },
];

function Replay() {
  return (
    <section id="replay" className="relative mx-auto max-w-[1160px] scroll-mt-24 px-5 pb-28 pt-20 sm:pb-36 sm:pt-24" aria-labelledby="replay-title">
      <Reveal className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Eyebrow>Flow B · five beats · one CRE run</Eyebrow>
          <SimulationLabel />
          <h2 id="replay-title" className="mt-5 max-w-[16ch] font-display text-balance text-[clamp(32px,4.4vw,56px)] leading-[1.08] text-fg">
            The Kelp Replay, contained
          </h2>
        </div>
        <Link href="/lab" className="group inline-flex h-11 shrink-0 items-center gap-2 self-start rounded-full border border-line-strong px-5 text-sm font-medium text-fg transition-colors hover:border-fg sm:self-auto">
          Open the Attack Lab
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
      </Reveal>
      <Reveal className="mt-12">
        <ReplayStrip />
      </Reveal>
      <ol className="relative mt-12 grid gap-4 md:grid-cols-5 md:gap-3">
        <span aria-hidden="true" className="absolute left-[19px] top-6 bottom-6 w-[2px] bg-wire md:left-6 md:right-6 md:top-[19px] md:bottom-auto md:h-[2px] md:w-auto" />
        <span aria-hidden="true" className="absolute left-[19px] top-6 hidden h-[2px] bg-[linear-gradient(90deg,var(--status-conserved),var(--status-broken)_45%,var(--status-quarantined))] md:left-6 md:right-6 md:block" />
        {BEATS.map((b, i) => {
          const Icon = b.icon;
          const tone = i === 0 ? "text-broken" : i === 4 ? "text-conserved" : i === 3 ? "text-quarantined" : "text-fg";
          return (
            <Reveal key={b.title} as="li" delay={i * 110} className="relative grid grid-cols-[40px_1fr] gap-4 md:block">
              <span className={cn("relative z-10 flex size-10 items-center justify-center rounded-full border border-wire bg-panel shadow-panel", tone)}>
                <Icon className="size-[18px]" aria-hidden="true" />
              </span>
              <div className="md:mt-5">
                <p className="font-mono text-xs text-subtle">{String(i + 1).padStart(2, "0")}</p>
                <p className="mt-1 text-lg font-semibold tracking-[-0.02em] text-fg">{b.title}</p>
                <p className="mt-1.5 max-w-[34ch] text-[14px] leading-relaxed text-muted">{b.line}</p>
              </div>
            </Reveal>
          );
        })}
      </ol>
      <Reveal delay={200}>
        <p className="mt-12 max-w-[70ch] text-sm leading-relaxed text-subtle">
          The forgery is simulated honestly: a WeakBridge message signed with its single verifier key, with no matching burn. It reproduces the effect of the Kelp attack, a credit with no debit, not LayerZero&apos;s exact bug.
        </p>
      </Reveal>
    </section>
  );
}

const SNIPPET = `abstract contract KirchhoffProtected {
    AggregatorV3Interface public immutable kirchhoffFeed;
    uint256 public constant MAX_AGE = 300;

    function _requireConserved() internal view {
        (, int256 s,, uint256 updatedAt,) = kirchhoffFeed.latestRoundData();
        if (block.timestamp - updatedAt > MAX_AGE) revert CollateralStatusStale(block.timestamp - updatedAt);
        if (s != 1 && s != 2) revert CollateralNotConserved(s); // 1 CONSERVED, 2 DRIFT
    }
}`;

function Chainlink() {
  const pillars = [
    { icon: Cpu, title: "CRE Conservation Engine", line: "Four workflows read every chain at pinned blocks with DON consensus and write signed reports to the ledger" },
    { icon: ShieldCheck, title: "CCV committee", line: "Every cell runs the same Judge. FAIL withholds the signature, so the message never executes" },
    { icon: Radio, title: "Conservation Feed", line: "An AggregatorV3 status feed per chain. Lenders stop borrowing against broken collateral" },
  ];
  return (
    <section id="chainlink" className="relative scroll-mt-24 border-t border-wire/60 py-28 sm:py-36" aria-labelledby="chainlink-title">
      <div className="mx-auto max-w-[1160px] px-5">
        <Reveal>
          <Eyebrow>Inside CCIP 2.0 · CRE · CCV · feed</Eyebrow>
          <h2 id="chainlink-title" className="max-w-[16ch] font-display text-balance text-[clamp(32px,4.4vw,56px)] leading-[1.08] text-fg">
            Inside CCIP 2.0
          </h2>
          <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-muted">
            Issuers can require their own verifier beside the Committee Verifier. Both must sign, so a refusal holds the message{" "}
            <a href={SOURCES.ccip} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-fg underline decoration-dotted underline-offset-4">
              Chainlink, Sept 28 2026
            </a>
          </p>
        </Reveal>
        <Reveal delay={100} className="mt-12">
          <ArchitectureDiagram />
        </Reveal>
        <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
          <div className="space-y-3">
            {pillars.map((p, i) => {
              const Icon = p.icon;
              return (
                <Reveal key={p.title} delay={i * 90}>
                  <div className="group flex gap-4 rounded-xl border border-transparent p-4 transition-colors hover:border-wire hover:bg-panel/60">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-wire bg-inset text-conserved transition-shadow group-hover:shadow-[0_0_0_4px_color-mix(in_oklab,var(--status-conserved)_12%,transparent)]">
                      <Icon className="size-[18px]" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="font-semibold text-fg">{p.title}</p>
                      <p className="mt-1 text-[15px] leading-relaxed text-muted">{p.line}</p>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
          <Reveal delay={120} className="min-w-0">
            <figure className="overflow-hidden rounded-2xl border border-wire bg-inset shadow-pop">
              <figcaption className="flex items-center justify-between gap-3 border-b border-wire px-4 py-3 text-xs text-muted">
                <span className="font-mono">KirchhoffProtected.sol</span>
                <span>One line in your lending market</span>
              </figcaption>
              <pre tabIndex={0} className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.75] text-muted">
                <code>
                  {SNIPPET.split("\n").map((l, i) => (
                    <span key={i} className={cn("block", /revert|_requireConserved/.test(l) && "text-fg", /\/\//.test(l) && "text-conserved")}>
                      {l || " "}
                    </span>
                  ))}
                </code>
              </pre>
            </figure>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Limits() {
  const items = [
    "Theft of real assets that keeps supply conserved, like a drained protocol vault",
    "DEX price manipulation, phishing or bugs in lending logic",
    "Swaps in the same block as the forged release, unless the token runs KirchhoffGuard",
  ];
  return (
    <section className="mx-auto max-w-[1160px] px-5 pb-28 sm:pb-36" aria-labelledby="limits-title">
      <Reveal className="grid gap-10 rounded-2xl border border-wire p-6 sm:p-10 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <h2 id="limits-title" className="font-display text-[clamp(26px,3vw,36px)] leading-[1.1] text-fg">
            Where the circuit ends
          </h2>
          <p className="mt-3 max-w-[38ch] text-[15px] leading-relaxed text-muted">It catches every path that creates value from nothing. It does not catch these</p>
        </div>
        <ul className="space-y-4">
          {items.map((t) => (
            <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-fg/90">
              <X className="mt-1 size-4 shrink-0 text-subtle" aria-hidden="true" />
              {t}
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

function Closing() {
  return (
    <section className="relative isolate overflow-hidden border-t border-wire/60 py-36 sm:py-48" aria-labelledby="closing-title">
      <CurrentField variant="ambient" className="absolute inset-0 -z-10 h-full w-full" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_60%_at_50%_50%,var(--bg-canvas)_20%,transparent_85%)]" />
      <Reveal className="mx-auto flex max-w-[1160px] flex-col items-center px-5 text-center">
        <h2 id="closing-title" className="font-display max-w-[14ch] text-balance text-[clamp(40px,6.4vw,88px)] leading-[1.02] text-fg">
          Watch the money add up
        </h2>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link href="/app" className="inline-flex h-12 items-center gap-2 rounded-full bg-fg px-6 text-[15px] font-semibold text-canvas transition-transform hover:-translate-y-0.5">
            Open Mission Control
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <Link href="/t/kETH" className="inline-flex h-12 items-center gap-2 rounded-full border border-line-strong bg-panel/60 px-6 text-[15px] font-medium text-fg backdrop-blur hover:border-fg">
            Public status page
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

export function Landing() {
  return (
    <div className="relative min-h-dvh overflow-x-clip">
      <LandingNav />
      <main id="main" className="overflow-x-clip">
        <Hero />
        <Problem />
        <Rules />
        <Live />
        <Replay />
        <Chainlink />
        <Limits />
        <Closing />
      </main>
      <footer className="border-t border-wire">
        <div className="mx-auto flex max-w-[1160px] flex-col gap-4 px-5 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2.5">
            <LogoMark className="size-6" />
            <Wordmark className="text-[12px]" />
          </span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SimulationLabel />
            <span>Ethereum Sepolia · Arbitrum Sepolia · Base Sepolia</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
