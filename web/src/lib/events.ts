import "server-only";
import { keccak256, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { spendPolicyAbi } from "./abi";
import { publicClient } from "./chain";
import { serverConfig, statsPolicies } from "./config";
import { getDb } from "./db";

/** One decoded SpendPolicy event, in chain order. */
export interface PolicyEvent {
  policy: Address;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}

/** Fetch all SpendPolicy events in fixed-size block chunks (RPC log-range limits). */
export async function fetchPolicyEvents(policy: Address, fromBlock: bigint): Promise<PolicyEvent[]> {
  const client = publicClient();
  const latest = await client.getBlockNumber();
  const chunk = serverConfig().PAYDAY_LOG_CHUNK;
  const out: PolicyEvent[] = [];
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
    // Address-only filter, decoded locally: Arc testnet's RPC rejects eth_getLogs with a long
    // topic OR-list (all 21 event signatures) as "requested range too large" even for tiny ranges.
    const raw = await client.getLogs({ address: policy, fromBlock: start, toBlock: end });
    const logs = parseEventLogs({ abi: spendPolicyAbi, logs: raw });
    for (const l of logs) {
      out.push({
        policy,
        eventName: l.eventName,
        args: (l.args ?? {}) as Record<string, unknown>,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        txHash: l.transactionHash,
      });
    }
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

export function currentPolicyEvents() {
  const cfg = serverConfig();
  return fetchPolicyEvents(cfg.PAYDAY_POLICY_ADDRESS, cfg.PAYDAY_POLICY_DEPLOY_BLOCK);
}

/** Allow-list as rebuilt from PayeeSet / PayeeRemoved events. */
export function payeesFromEvents(events: PolicyEvent[]) {
  const map = new Map<Address, { address: Address; label: string; category: Hex; cap: bigint }>();
  for (const e of events) {
    if (e.eventName === "PayeeSet") {
      const a = e.args as { payee: Address; label: string; category: Hex; cap: bigint };
      map.set(a.payee, { address: a.payee, label: a.label, category: a.category, cap: a.cap });
    } else if (e.eventName === "PayeeRemoved") {
      map.delete((e.args as { payee: Address }).payee);
    }
  }
  return [...map.values()];
}

// PaymentCancelled no longer exists (agent cancel removed, audit L-06); only the owner rejects.
const CLOSING = new Set(["PaymentApproved", "PaymentRejected", "PaymentExpired"]);

/** Pending payments = PaymentPending without a later closing event. */
export function pendingFromEvents(events: PolicyEvent[]) {
  const open = new Map<Hex, PolicyEvent>();
  for (const e of events) {
    const id = e.args.paymentId as Hex | undefined;
    if (!id) continue;
    if (e.eventName === "PaymentPending") open.set(id, e);
    else if (CLOSING.has(e.eventName)) open.delete(id);
  }
  return [...open.values()];
}

export interface LogEntry {
  eventName: string;
  paymentId: Hex;
  reasonHash: Hex;
  blockNumber: string;
  txHash: Hex;
  payee: Address | null;
  amount: string | null;
  extra: Record<string, string>;
  reasonDoc: unknown | null;
  verified: boolean; // keccak256(canonical stored JSON) === on-chain reasonHash
}

/** Decision log = payment events from chain, joined with app reason JSON verified against reasonHash. */
export async function buildDecisionLog(): Promise<LogEntry[]> {
  const events = await currentPolicyEvents();
  const docStmt = getDb().prepare("SELECT canonical_json FROM reason_docs WHERE reason_hash = ?");
  const out: LogEntry[] = [];
  for (const e of events) {
    const a = e.args as Record<string, unknown>;
    if (!a.paymentId || !a.reasonHash) continue;
    const reasonHash = a.reasonHash as Hex;
    const row = docStmt.get(reasonHash.toLowerCase()) as { canonical_json: string } | undefined;
    const verified = !!row && keccak256(toBytes(row.canonical_json)).toLowerCase() === reasonHash.toLowerCase();
    const extra: Record<string, string> = {};
    for (const k of ["ownerApproved", "overLimits", "expiresAt", "approver", "invoiceKey", "agentEpoch", "payeeEpoch"]) {
      if (a[k] !== undefined) extra[k] = String(a[k]);
    }
    out.push({
      eventName: e.eventName,
      paymentId: a.paymentId as Hex,
      reasonHash,
      blockNumber: e.blockNumber.toString(),
      txHash: e.txHash,
      payee: (a.payee as Address | undefined) ?? null,
      amount: a.amount !== undefined ? String(a.amount) : null,
      extra,
      reasonDoc: row ? JSON.parse(row.canonical_json) : null,
      verified,
    });
  }
  return out;
}

let statsCache: { at: number; value: PublicStats } | null = null;

export interface PublicStats {
  transactions: number;
  volumeUnits: string;
  businesses: number;
  payees: number;
  recent: { txHash: Hex; policy: Address; payee: Address; amount: string; blockNumber: string }[];
}

/** Public stats: counts ONLY on-chain PaymentExecuted events. Cached 60 s. */
export async function publicStats(): Promise<PublicStats> {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.value;
  const businesses = new Set<string>();
  const payees = new Set<string>();
  let volume = 0n;
  const executed: PublicStats["recent"] = [];
  for (const p of statsPolicies()) {
    const events = await fetchPolicyEvents(p.address, p.fromBlock);
    for (const e of events) {
      if (e.eventName !== "PaymentExecuted") continue;
      const a = e.args as { payee: Address; amount: bigint };
      businesses.add(p.address);
      payees.add(a.payee);
      volume += a.amount;
      executed.push({ txHash: e.txHash, policy: p.address, payee: a.payee, amount: a.amount.toString(), blockNumber: e.blockNumber.toString() });
    }
  }
  const value: PublicStats = {
    transactions: executed.length,
    volumeUnits: volume.toString(),
    businesses: businesses.size,
    payees: payees.size,
    recent: executed.slice(-20).reverse(),
  };
  statsCache = { at: Date.now(), value };
  return value;
}

export function clearStatsCacheForTests() {
  statsCache = null;
}
