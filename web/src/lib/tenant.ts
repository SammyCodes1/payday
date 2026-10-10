import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAddress, isAddress, type Address } from "viem";
import { serverConfig } from "./config";

/**
 * Multi-tenant context. Every business has its OWN SpendPolicy (created through
 * SpendPolicyFactory with the business wallet as owner). A request is bound to exactly one
 * policy: `handle()` opens a scope, `requireOwner()` fills it with the signed-in owner's policy,
 * and everything downstream (chain reads, invoices, payees, executor) uses `activePolicy()`.
 *
 * Inside a request scope with no bound tenant, activePolicy() throws (403). Outside any scope
 * (scripts, tests) the configured PAYDAY_POLICY_ADDRESS (Sammy's demo policy) is used.
 */
export interface TenantScope {
  policy?: Address;
  owner?: Address;
  /** HTTP request scope: never fall back to the demo policy (fails CLOSED, review F-1). */
  request?: boolean;
}

export class NoTenantError extends Error {
  status = 403;
  constructor() {
    super("no Payday policy is linked to this request");
  }
}

const store = new AsyncLocalStorage<TenantScope>();

export function runInScope<T>(fn: () => Promise<T>, scope: TenantScope = { request: true }): Promise<T> {
  return store.run(scope, fn);
}

/** Run `fn` bound to a specific policy (scheduler / background jobs). */
export function withPolicy<T>(policy: Address, fn: () => Promise<T>): Promise<T> {
  return store.run({ policy }, fn);
}

export function bindScope(policy: Address, owner: Address) {
  const s = store.getStore();
  if (!s) throw new Error("bindScope called outside a request scope");
  s.policy = policy;
  s.owner = owner;
}

/**
 * The policy this code path is bound to. Inside an HTTP request scope it MUST have been bound by
 * requireOwner (which only maps the demo policy to its on-chain owner); otherwise this throws
 * (403) instead of silently using the demo policy. Only scripts/tests outside any scope use the
 * configured PAYDAY_POLICY_ADDRESS; background jobs should bind explicitly with withPolicy().
 */
export function activePolicy(): Address {
  const s = store.getStore();
  if (s?.policy) return s.policy;
  if (s?.request) throw new NoTenantError();
  return serverConfig().PAYDAY_POLICY_ADDRESS;
}

export function defaultPolicy(): Address {
  return serverConfig().PAYDAY_POLICY_ADDRESS;
}

/** Earliest block to scan for the active policy's events. */
export function activeFromBlock(lookup: (policy: Address) => bigint | undefined): bigint {
  const p = activePolicy();
  if (p === defaultPolicy()) return serverConfig().PAYDAY_POLICY_DEPLOY_BLOCK;
  return lookup(p) ?? 0n;
}

export const checksum = (a: string): Address => {
  if (!isAddress(a)) throw new Error("invalid address");
  return getAddress(a);
};
