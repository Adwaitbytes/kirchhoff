import { parseEventLogs, type Account, type Address, type Hex } from "viem";
import { erc20Abi, weakBridgeAbi } from "./abi.ts";
import { account, read, send, TxError, type Sent } from "./chain.ts";
import { tokenOf, type Context } from "./context.ts";
import type { ChainRole } from "./networks.ts";

/** Approve `spender` for at least `amount` of the token on `role` (idempotent). */
export async function approveToken(ctx: Context, role: ChainRole, owner: Account, spender: Address, amount: bigint): Promise<void> {
  const chain = ctx.chains[role];
  const token = tokenOf(ctx, role);
  const current = await read<bigint>(chain, { to: token, abi: erc20Abi, functionName: "allowance", args: [owner.address, spender] });
  if (current >= amount) return;
  await send(chain, owner, { to: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }, `approve ${spender}`);
}

/**
 * WeakBridge debit on `from`: locks into the HomeEscrowAdapter (home) or burns (remote). Returns the message id read
 * from the Burned event (topic 1).
 */
export async function weakBridgeSend(ctx: Context, from: ChainRole, sender: Account, to: Address, amount: bigint, dst: ChainRole): Promise<{ id: Hex; sent: Sent }> {
  const chain = ctx.chains[from];
  const bridge = ctx.at(from, "weakBridge");
  const spender = from === "home" ? ctx.at(from, "homeEscrowAdapter") : bridge;
  await approveToken(ctx, from, sender, spender, amount);
  const sent = await send(
    chain,
    sender,
    { to: bridge, abi: weakBridgeAbi, functionName: "send", args: [to, amount, ctx.net.chains[dst].selector] },
    `WeakBridge send ${amount} to ${dst}`,
  );
  const burned = parseEventLogs({ abi: weakBridgeAbi, logs: sent.receipt.logs, eventName: "Burned" })[0];
  if (burned === undefined) throw new TxError("WeakBridge send emitted no Burned event");
  return { id: burned.args.id, sent };
}

/** Verifier signature over the EIP-712 credit digest, then a relayed `credit`. Used by seed (legit round trip). */
export async function weakBridgeCredit(
  ctx: Context,
  on: ChainRole,
  id: Hex,
  to: Address,
  amount: bigint,
  srcChain: ChainRole,
  relayer: Account = account("DEPLOYER"),
): Promise<Sent> {
  const chain = ctx.chains[on];
  const bridge = ctx.at(on, "weakBridge");
  const signature = await signCredit(ctx, on, id, to, amount, srcChain);
  return send(
    chain,
    relayer,
    { to: bridge, abi: weakBridgeAbi, functionName: "credit", args: [id, to, amount, ctx.net.chains[srcChain].selector, signature] },
    `WeakBridge credit ${amount} to ${to}`,
  );
}

/**
 * Signs a WeakBridge credit with the single verifier key. The Kelp Replay uses this to authorize a credit with no
 * matching debit; seed uses it for a legitimate round trip. The digest is read from the contract so the EIP-712
 * domain (chain id + bridge address) is exactly the one the contract verifies.
 */
export async function signCredit(ctx: Context, on: ChainRole, id: Hex, to: Address, amount: bigint, srcChain: ChainRole): Promise<Hex> {
  const chain = ctx.chains[on];
  const bridge = ctx.at(on, "weakBridge");
  const digest = await read<Hex>(chain, {
    to: bridge,
    abi: weakBridgeAbi,
    functionName: "creditDigest",
    args: [id, to, amount, ctx.net.chains[srcChain].selector],
  });
  const verifier = account("WEAKBRIDGE_VERIFIER");
  if (verifier.sign === undefined) throw new TxError("verifier account cannot sign a hash");
  return verifier.sign({ hash: digest });
}
