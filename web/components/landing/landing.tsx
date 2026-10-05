"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Cpu, FlaskConical, Lock, OctagonX, Radio, ScanSearch, ShieldCheck, Sigma, X, Zap } from "lucide-react";
import { useNow, useTokens } from "@/lib/api/hooks";
import { formatAge, formatAmount, parseWei, secondsBetween } from "@/lib/format";
import { STATUS_STYLE } from "@/lib/status";
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
  const age = now === 0 ? null : secondsBetween(t.updatedAt, now);
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
        {t.symbol} Δ {formatAmount(parseWei(t.delta), { decimals: t.decimals, maxFraction: 0, signed: true })}
      </span>
      <span className="hidden truncate text-muted sm:inline">{age === null ? "" : `checked ${formatAge(age)} ago`}</span>
      <ArrowUpRight className="size-4 shrink-0 text-subtle transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

function Hero() {
  return (
    <section className="relative isolate flex min-h-[100svh] flex-col overflow-hidden" aria-labelledby="hero-title">
      <CurrentField variant="hero" className="absolute inset-0 -z-10 h-full w-full" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[62%] bg-[radial-gradient(60%_70%_at_50%_30%,var(--bg-canvas)_30%,transparent_80%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-t from-canvas to-transparent" />

      <div className="mx-auto flex w-full max-w-[1160px] flex-1 flex-col items-center px-5 pb-[34svh] pt-28 text-center sm:pt-36">
        <Enter>
          <span className="inline-flex items-center gap-2 rounded-full border border-wire bg-panel/70 px-3.5 py-1.5 font-mono text-[12px] text-muted backdrop-blur">
            <span className="size-1.5 rounded-full bg-conserved shadow-[0_0_8px_var(--status-conserved)]" aria-hidden="true" />
            Cross-Chain Verifier for CCIP 2.0
          </span>
        </Enter>
        <Enter delay={90}>
          <h1 id="hero-title" className="mt-7 max-w-[15ch] text-balance text-[clamp(44px,8.2vw,108px)] font-semibold leading-[0.95] tracking-[-0.048em] text-fg">
            Every bridge checks who signed
          </h1>
        </Enter>
        <Enter delay={180}>
          <p className="mt-5 max-w-[30ch] text-balance text-[clamp(22px,2.6vw,34px)] font-medium leading-[1.12] tracking-[-0.025em] text-muted">
            KIRCHHOFF checks if the money adds up
          </p>
        </Enter>
        <Enter delay={260}>
          <p className="mx-auto mt-6 max-w-[56ch] text-pretty text-[17px] leading-relaxed text-muted">
            A verifier inside CCIP 2.0 that refuses to sign the moment a token&apos;s supply stops balancing across chains. Value in equals value out, or nothing moves.
          </p>
        </Enter>
        <Enter delay={340} className="mt-8 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/app"
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-fg px-6 text-[15px] font-semibold text-canvas shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_2px_4px_rgb(0_0_0/0.3)] transition-[transform,box-shadow] hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_14px_32px_-10px_color-mix(in_oklab,var(--status-conserved)_70%,transparent)]"
            >
              Open Mission Control
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
            <Link
              href="/lab"
              className="inline-flex h-12 items-center gap-2 rounded-full border border-line-strong bg-panel/60 px-6 text-[15px] font-medium text-fg backdrop-blur transition-[border-color,background-color] hover:border-broken/60 hover:bg-broken/10"
            >
              <FlaskConical className="size-4 text-broken" aria-hidden="true" />
              Run the Kelp Replay
            </Link>
          </div>
          <LiveStatus />
        </Enter>
      </div>

      <div className="pointer-events-none absolute inset-0 -z-[5] font-mono text-[11px]" aria-hidden="true">
        <span className="absolute left-[4%] top-[70%] hidden -translate-y-6 text-muted sm:block">Arbitrum Sepolia</span>
        <span className="absolute right-[4%] top-[70%] hidden -translate-y-6 text-muted sm:block">Base Sepolia</span>
      </div>
    </section>
  );
}

function Stat({ value, label, href, source }: { value: string; label: string; href: string; source: string }) {
  return (
    <div className="border-t border-wire pt-5">
      <p className="font-mono text-[clamp(28px,3.2vw,40px)] font-medium tracking-[-0.03em] text-fg tnum">{value}</p>
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
          <h2 id="problem-title" className="text-[15px] font-medium text-muted">
            One forged message
          </h2>
          <p className="relative isolate mt-4 font-mono text-[clamp(72px,15vw,184px)] font-medium leading-[0.86] tracking-[-0.06em] text-fg tnum">
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
        <h3 className="mt-6 text-[clamp(26px,2.6vw,34px)] font-semibold tracking-[-0.03em] text-fg">{title}</h3>
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
        <h2 id="live-title" className="max-w-[18ch] text-balance text-[clamp(36px,5vw,64px)] font-semibold leading-[1.02] tracking-[-0.04em] text-fg">
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

function Rules() {
  return (
    <section id="rules" className="relative scroll-mt-24 border-y border-wire/60 bg-[linear-gradient(180deg,transparent,color-mix(in_oklab,var(--bg-panel)_55%,transparent)_30%,transparent)] py-28 sm:py-36" aria-labelledby="rules-title">
      <div className="mx-auto max-w-[1160px] px-5">
        <Reveal>
          <h2 id="rules-title" className="max-w-[18ch] text-balance text-[clamp(36px,5vw,64px)] font-semibold leading-[1.02] tracking-[-0.04em] text-fg">
            Two laws, one circuit
          </h2>
          <p className="mt-5 max-w-[58ch] text-[17px] leading-relaxed text-muted">
            Borrowed from Kirchhoff&apos;s circuit laws. Chains are nodes, bridges are wires, money is current. When the current stops adding up, the circuit opens.
          </p>
        </Reveal>
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
    <section id="replay" className="relative mx-auto max-w-[1160px] scroll-mt-24 px-5 py-28 sm:py-36" aria-labelledby="replay-title">
      <Reveal className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <SimulationLabel />
          <h2 id="replay-title" className="mt-5 max-w-[16ch] text-balance text-[clamp(36px,5vw,64px)] font-semibold leading-[1.02] tracking-[-0.04em] text-fg">
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
          <h2 id="chainlink-title" className="max-w-[16ch] text-balance text-[clamp(36px,5vw,64px)] font-semibold leading-[1.02] tracking-[-0.04em] text-fg">
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
              <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.75] text-muted">
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
          <h2 id="limits-title" className="text-[clamp(28px,3.4vw,40px)] font-semibold tracking-[-0.035em] text-fg">
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
        <h2 id="closing-title" className="max-w-[14ch] text-balance text-[clamp(44px,7vw,96px)] font-semibold leading-[0.96] tracking-[-0.048em] text-fg">
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
