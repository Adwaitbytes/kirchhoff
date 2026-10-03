import type { EpochObservation, HistoryEvent } from "../src/backtest.ts";
import type { SourceView } from "../src/junction.ts";
import { rescale } from "../src/units.ts";
import { decimalsOn, specChains } from "../src/chains.ts";
import type { ChainSel, Credit, Debit, Hex, TokenSpec } from "../src/types.ts";
import { ALICE, HOME, hash } from "./fixtures.ts";

const BLOCK_SECONDS = 12n;

/**
 * A three-chain lock-and-release world that emits the history W2 would see.
 * Every step mines one block on every chain, so a chain's block number is the
 * global step and pins can lag behind it. Balances are recorded per block so a
 * lagging pin reads the balance as of that block.
 */
export class World {
  step = 0n;
  escrow = 0n;
  readonly supplies = new Map<ChainSel, bigint>();
  readonly history: HistoryEvent[] = [];
  /** Debits sent but not yet credited, in send order. */
  readonly pending: Debit[] = [];
  /** Debits already credited once. */
  readonly delivered: Debit[] = [];
  donated = 0n;
  private epochId = 0n;
  private nonce = 0;
  private readonly escrowAt: { block: bigint; value: bigint }[] = [{ block: 0n, value: 0n }];
  private readonly supplyAt = new Map<ChainSel, { block: bigint; value: bigint }[]>();

  readonly spec: TokenSpec;

  constructor(spec: TokenSpec) {
    this.spec = spec;
    for (const r of spec.remotes) {
      this.supplies.set(r.chain.selector, 0n);
      this.supplyAt.set(r.chain.selector, [{ block: 0n, value: 0n }]);
    }
  }

  get now(): bigint {
    return this.step * BLOCK_SECONDS;
  }

  remotes(): ChainSel[] {
    return this.spec.remotes.map((r) => r.chain.selector);
  }

  /** Native amount on `chain` for a canonical amount (exact for amounts built with `granularity`). */
  native(chain: ChainSel, canonical: bigint): bigint {
    return rescale(canonical, this.spec.home.decimals, decimalsOn(this.spec, chain));
  }

  /** Smallest canonical amount representable on both chains. */
  granularity(a: ChainSel, b: ChainSel): bigint {
    const min = Math.min(decimalsOn(this.spec, a), decimalsOn(this.spec, b), this.spec.home.decimals);
    return 10n ** BigInt(this.spec.home.decimals - min);
  }

  private tick(): void {
    this.step += 1n;
  }

  private record(chain: ChainSel): void {
    if (chain === HOME) {
      this.escrowAt.push({ block: this.step, value: this.escrow });
    } else {
      this.supplyAt.get(chain)?.push({ block: this.step, value: this.supplies.get(chain) ?? 0n });
    }
  }

  private move(chain: ChainSel, nativeDelta: bigint): void {
    if (chain === HOME) this.escrow -= nativeDelta;
    else this.supplies.set(chain, (this.supplies.get(chain) ?? 0n) + nativeDelta);
    this.record(chain);
  }

  /** A debit: lock on home (escrow up) or burn on a remote (supply down). */
  send(src: ChainSel, dst: ChainSel, canonical: bigint, recipient: Hex = ALICE): Debit {
    this.tick();
    const amount = this.native(src, canonical);
    this.move(src, -amount);
    const debit: Debit = {
      messageId: hash(`msg-${(this.nonce++).toString()}`),
      srcChain: src,
      dstChain: dst,
      amount,
      recipient,
      txHash: hash(`debit-${this.step.toString()}`),
      block: this.step,
    };
    this.history.push({ kind: "debit", debit });
    this.pending.push(debit);
    return debit;
  }

  /** A credit for a debit, optionally tampered with. Applies the credit's real effect on balances. */
  credit(d: Debit, over: Partial<Credit> = {}): Credit {
    this.tick();
    const credit: Credit = {
      messageId: d.messageId,
      claimedSrcChain: d.srcChain,
      dstChain: d.dstChain,
      amount: this.native(d.dstChain, rescale(d.amount, decimalsOn(this.spec, d.srcChain), this.spec.home.decimals)),
      recipient: d.recipient ?? ALICE,
      txHash: hash(`credit-${this.step.toString()}`),
      block: this.step,
      ...over,
    };
    this.move(credit.dstChain, credit.amount);
    this.history.push({ kind: "credit", credit, timestamp: this.now });
    return credit;
  }

  deliver(index: number, over: Partial<Credit> = {}): Credit | null {
    const [d] = this.pending.splice(index % Math.max(this.pending.length, 1), 1);
    if (d === undefined) return null;
    this.delivered.push(d);
    return this.credit(d, over);
  }

  /** A forged credit with no debit behind it. */
  forge(dst: ChainSel, claimedSrc: ChainSel, nativeAmount: bigint, recipient: Hex): Credit {
    const fake: Debit = {
      messageId: hash(`forged-${(this.nonce++).toString()}`),
      srcChain: claimedSrc,
      dstChain: dst,
      amount: 0n,
      recipient,
      txHash: hash("never"),
      block: 0n,
    };
    return this.credit(fake, { amount: nativeAmount });
  }

  /** A compromised minter key minting with no message. */
  directMint(chain: ChainSel, nativeAmount: bigint): void {
    this.tick();
    this.move(chain, nativeAmount);
  }

  /** Anyone can send tokens to the escrow. */
  donate(nativeAmount: bigint): void {
    this.tick();
    this.escrow += nativeAmount;
    this.donated += nativeAmount;
    this.record(HOME);
  }

  private static at(series: readonly { block: bigint; value: bigint }[], block: bigint): bigint {
    let value = 0n;
    for (const entry of series) if (entry.block <= block) value = entry.value;
    return value;
  }

  /** An epoch pinned `lag(chain)` blocks behind the head of each chain. */
  epoch(lag: (chain: ChainSel) => bigint = () => 0n): EpochObservation {
    this.tick();
    const sources = new Map<ChainSel, SourceView>();
    for (const chain of specChains(this.spec)) {
      const pin = this.step - lag(chain.selector);
      sources.set(chain.selector, { head: pin, headTimestamp: pin * BLOCK_SECONDS });
    }
    const pinOf = (c: ChainSel): bigint => sources.get(c)?.head ?? 0n;
    this.epochId += 1n;
    const epoch: EpochObservation = {
      timestamp: this.now,
      sources,
      snapshot: {
        model: "lock_release_home",
        epochId: this.epochId,
        pinned: [...sources].map(([chain, v]) => ({ chain, block: v.head })),
        escrow: World.at(this.escrowAt, pinOf(HOME)),
        supplies: this.remotes().map((chain) => ({ chain, supply: World.at(this.supplyAt.get(chain) ?? [], pinOf(chain)) })),
      },
    };
    this.history.push({ kind: "epoch", epoch });
    return epoch;
  }
}
