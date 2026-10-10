/**
 * End-to-end, fully local: real SpendPolicy + MockUSDC bytecode from ../out on a fresh anvil,
 * the real Next route handlers, SQLite in a temp dir, the offline mock LLM and the local
 * anvil agent executor. Accounts come from Foundry's PUBLIC test mnemonic at runtime.
 *
 *   upload -> extract -> decide -> requestPayment (Executed | Pending) -> owner approval
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Abi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { spendPolicyAbi } from "@/lib/abi";
import { spendPolicyFactoryAbi } from "@/lib/factory-abi";
import { categoryToBytes32, computeInvoiceKey } from "@/lib/ids";
import { APPROVE_TYPES, approvalDomain, approvalMessage } from "@/lib/eip712";
import { PUBLIC_TEST_MNEMONIC } from "@/lib/executor/local";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FIX = join(import.meta.dirname, "..", "..", "fixtures", "invoices");
const ORIGIN = "http://localhost:3000";
const U = 1_000_000n;
const acct = (i: number) => mnemonicToAccount(PUBLIC_TEST_MNEMONIC, { addressIndex: i });
const owner = acct(0);
const agent = acct(2);
const ADEBAYO = acct(3).address;
const PAPER = acct(4).address;
const CHIDI = acct(5).address;
const outsider = acct(6);
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;

let anvil: ChildProcess;
let rpc: string;
let tmp: string;
let policy: Address;
let usdc: Address;
let cookie = "";

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

function artifact(file: string, name: string) {
  const j = JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

// Route handlers (imported after env is set).
type Routes = Awaited<ReturnType<typeof loadRoutes>>;
let R: Routes;
async function loadRoutes() {
  return {
    nonce: await import("@/app/api/auth/nonce/route"),
    verify: await import("@/app/api/auth/verify/route"),
    me: await import("@/app/api/auth/me/route"),
    invoices: await import("@/app/api/invoices/route"),
    invoice: await import("@/app/api/invoices/[id]/route"),
    resolve: await import("@/app/api/invoices/[id]/resolve/route"),
    approvals: await import("@/app/api/approvals/route"),
    relay: await import("@/app/api/approvals/relay/route"),
    payees: await import("@/app/api/payees/route"),
    policy: await import("@/app/api/policy/route"),
    log: await import("@/app/api/log/route"),
    stats: await import("@/app/api/stats/route"),
    cron: await import("@/app/api/cron/due/route"),
    tenants: await import("@/app/api/tenants/route"),
    proxy: await import("@/proxy"),
    clock: await import("@/lib/clock"),
    chain: await import("@/lib/chain"),
    events: await import("@/lib/events"),
    rate: await import("@/lib/rate-limit"),
  };
}

function req(path: string, init: RequestInit & { cookie?: string | null; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  headers.set("x-forwarded-for", init.ip ?? "127.0.0.1");
  const c = init.cookie === undefined ? cookie : init.cookie;
  if (c) headers.set("cookie", c);
  return new Request(ORIGIN + path, { ...init, headers });
}
const jsonBody = (b: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let uploadIp = 0;
async function upload(name: string, type = name.endsWith(".png") ? "image/png" : "application/pdf", ip = `10.0.0.${++uploadIp}`) {
  const fd = new FormData();
  fd.set("file", new File([readFileSync(join(FIX, name))], name, { type }));
  const res = await R.invoices.POST(req("/api/invoices", { method: "POST", body: fd, ip }));
  return { res, body: (await res.json()) as { invoice: Record<string, unknown> & { id: string; decision: string; status: string; injection: { rule: string }[] } } };
}

async function signIn(account: ReturnType<typeof acct>) {
  const n = (await (await R.nonce.GET(req("/api/auth/nonce", { cookie: null }))).json()) as { nonce: string; domain: string; uri: string; chainId: number };
  const message = createSiweMessage({ address: account.address, chainId: n.chainId, domain: n.domain, nonce: n.nonce, uri: n.uri, version: "1" });
  const signature = await account.signMessage({ message });
  return { res: await R.verify.POST(req("/api/auth/verify", { ...jsonBody({ message, signature }), cookie: null })), message, signature };
}

const pub = () => createPublicClient({ chain: foundry, transport: http(rpc) });
const wallet = (a: ReturnType<typeof acct>) => createWalletClient({ account: a, chain: foundry, transport: http(rpc) });
const bal = (who: Address) => pub().readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

beforeAll(async () => {
  if (!existsSync(join(ROOT, "out", "SpendPolicy.sol", "SpendPolicy.json"))) {
    const b = spawnSync("forge", ["build"], { cwd: ROOT, stdio: "inherit" });
    if (b.status !== 0) throw new Error("forge build failed");
  }
  const port = await freePort();
  rpc = `http://127.0.0.1:${port}`;
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await pub().getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Deploy MockUSDC + the real SpendPolicy.
  const pc = pub();
  const ow = wallet(owner);
  const tok = artifact("MockUSDC.sol", "MockUSDC");
  let h = await ow.deployContract({ abi: tok.abi, bytecode: tok.bytecode });
  usdc = (await pc.waitForTransactionReceipt({ hash: h })).contractAddress!;
  const sp = artifact("SpendPolicy.sol", "SpendPolicy");
  h = await ow.deployContract({ abi: sp.abi, bytecode: sp.bytecode, args: [usdc, owner.address, agent.address, 1000n * U, 5000n * U, 20000n * U, 7n * 86400n] });
  policy = (await pc.waitForTransactionReceipt({ hash: h })).contractAddress!;

  const w = (functionName: string, args: unknown[]) =>
    ow.writeContract({ address: policy, abi: spendPolicyAbi, functionName: functionName as never, args: args as never }).then((hash) => pc.waitForTransactionReceipt({ hash }));
  for (const c of ["RENT", "SUPPLIES", "REPAIRS"]) await w("setCategoryBudget", [categoryToBytes32(c), 3000n * U]);
  await w("setPayee", [ADEBAYO, "Adebayo Properties", categoryToBytes32("RENT"), 0n]);
  await w("setPayee", [PAPER, "Lagos Paper Co", categoryToBytes32("SUPPLIES"), 0n]);
  await w("setPayee", [CHIDI, "Chidi Generator Repairs", categoryToBytes32("REPAIRS"), 3000n * U]);
  await pc.waitForTransactionReceipt({ hash: await ow.writeContract({ address: usdc, abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }], functionName: "mint", args: [policy, 10_000n * U] }) });

  tmp = mkdtempSync(join(tmpdir(), "payday-e2e-"));
  Object.assign(process.env, {
    PAYDAY_CHAIN: "anvil",
    PAYDAY_RPC_URL: rpc,
    PAYDAY_POLICY_ADDRESS: policy,
    PAYDAY_POLICY_DEPLOY_BLOCK: "0",
    PAYDAY_EXECUTOR: "local",
    PAYDAY_LOCAL_AGENT_INDEX: "2",
    PAYDAY_LLM_PROVIDER: "mock",
    SESSION_SECRET: randomBytes(32).toString("hex"), // generated per run, never stored
    CRON_SECRET: randomBytes(32).toString("hex"),
    PAYDAY_DB_PATH: join(tmp, "payday.sqlite"),
    PAYDAY_APP_ORIGIN: ORIGIN,
  });
  R = await loadRoutes();
  R.clock.setClockForTests(() => new Date("2026-10-04T09:00:00Z"));
  R.rate.resetRateLimitsForTests();
});

afterAll(() => {
  anvil?.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const ids = {} as Record<"normal" | "injection" | "overcap" | "future" | "large", string>;

describe("e2e: local anvil + real SpendPolicy", () => {
  it("rejects unauthenticated access (proxy and route) and non-owner sign-in", async () => {
    const p = await R.proxy.proxy(Object.assign(req("/api/invoices", { cookie: null }), { nextUrl: new URL(ORIGIN + "/api/invoices"), cookies: { get: () => undefined } }) as never);
    expect(p.status).toBe(401);
    expect((await R.invoices.GET(req("/api/invoices", { cookie: null }))).status).toBe(401);
    expect((await R.stats.GET(req("/api/stats", { cookie: null }))).status).toBe(200); // public
    const { res } = await signIn(outsider);
    expect(res.status).toBe(403);
  });

  it("owner signs in with SIWE; nonce cannot be replayed", async () => {
    const { res, message, signature } = await signIn(owner);
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    cookie = set.split(";")[0]!;
    expect(((await (await R.me.GET(req("/api/auth/me"))).json()) as { address: string }).address).toBe(owner.address);
    const replay = await R.verify.POST(req("/api/auth/verify", { ...jsonBody({ message, signature }), cookie: null }));
    expect(replay.status).toBe(401);
  });

  it("refuses cross-origin writes", async () => {
    const r = new Request(ORIGIN + "/api/payees", { method: "POST", headers: { origin: "https://evil.example", cookie, "content-type": "application/json" }, body: "{}" });
    expect((await R.payees.POST(r)).status).toBe(403);
  });

  it("owner stores app-side identifiers, bank details and agreed terms for on-chain payees", async () => {
    const save = async (b: unknown) => (await R.payees.POST(req("/api/payees", jsonBody(b)))).status;
    expect(await save({ address: ADEBAYO, identifiers: ["RC-1234567"], aliases: ["Adebayo Properties Ltd"], bankDetails: "GTBank 0123456789", terms: { kind: "fixed", amount: "800.00", period: "month" } })).toBe(200);
    expect(await save({ address: PAPER, identifiers: ["RC-7654321"], aliases: [], bankDetails: null, terms: { kind: "unit", unitPrice: "2.50", unit: "ream" } })).toBe(200);
    expect(await save({ address: CHIDI, identifiers: ["TIN-55667788"], aliases: [], bankDetails: null, terms: { kind: "milestones", items: [{ name: "Phase 1 diagnosis", amount: "300.00" }, { name: "Phase 2 overhaul", amount: "1450.00" }] } })).toBe(200);
    expect(await save({ address: outsider.address, identifiers: [], aliases: [], bankDetails: null, terms: null })).toBe(409); // not on chain
    const list = (await (await R.payees.GET(req("/api/payees"))).json()) as { payees: { address: string; label: string }[] };
    expect(list.payees.map((p) => p.label).sort()).toEqual(["Adebayo Properties", "Chidi Generator Repairs", "Lagos Paper Co"]);
  });

  it("upload limits: 415 wrong type, 415 lying type, 413 too large", async () => {
    expect((await upload("01-normal.pdf", "text/html")).res.status).toBe(415);
    expect((await upload("01-normal.pdf", "image/png")).res.status).toBe(415);
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(6 * 1024 * 1024)], "big.pdf", { type: "application/pdf" }));
    expect((await R.invoices.POST(req("/api/invoices", { method: "POST", body: fd }))).status).toBe(413);
  });

  it("upload rate limit: 429 after 10 uploads/minute from one client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await upload("01-normal.pdf", "text/plain", "192.0.2.77")).res.status);
    expect(statuses.slice(0, 10).every((s) => s === 415)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("normal invoice -> PAY_NOW -> executed on chain to the allow-listed address", async () => {
    const { res, body } = await upload("01-normal.pdf");
    expect(res.status).toBe(201);
    expect(body.invoice).toMatchObject({ decision: "PAY_NOW", status: "EXECUTED", payeeAddress: ADEBAYO });
    expect(await bal(ADEBAYO)).toBe(800n * U);
    ids.normal = body.invoice.id;
    // The invoice is locked on chain by its invoiceKey (payee + invoice number, amount excluded; L-01).
    const inv = body.invoice as unknown as { paymentId: Hex; extraction: { invoiceNumber: string } };
    const key = computeInvoiceKey({ chainId: 31337, policy, payee: ADEBAYO, invoiceNumber: inv.extraction.invoiceNumber });
    expect(await pub().readContract({ address: policy, abi: spendPolicyAbi, functionName: "invoicePayment", args: [key] })).toBe(inv.paymentId);
  });

  it("injection invoice -> ESCALATE, flags shown, nothing sent to the attacker", async () => {
    const { body } = await upload("02-injection.pdf");
    expect(body.invoice).toMatchObject({ decision: "ESCALATE", status: "ESCALATED", txHash: null });
    const rules = new Set(body.invoice.injection.map((f) => f.rule));
    for (const r of ["ignore-instructions", "pay-to-address", "secrecy", "approval-bypass", "move-all-funds"]) expect(rules.has(r)).toBe(true);
    expect(await bal(ATTACKER)).toBe(0n);
    expect(await bal(PAPER)).toBe(0n);
    ids.injection = body.invoice.id;
  });

  it("changed bank details -> ESCALATE", async () => {
    const { body } = await upload("03-changed-bank.pdf");
    expect(body.invoice).toMatchObject({ decision: "ESCALATE", status: "ESCALATED" });
  });

  it("duplicate -> REJECT (same paymentId already executed)", async () => {
    const { body } = await upload("04-duplicate.pdf");
    expect(body.invoice).toMatchObject({ decision: "REJECT", status: "REJECTED" });
    expect(await bal(ADEBAYO)).toBe(800n * U);
  });

  it("over-cap milestone -> ASK -> parked as Pending by the contract", async () => {
    const { body } = await upload("05-over-cap.pdf");
    expect(body.invoice).toMatchObject({ decision: "ASK", status: "ONCHAIN_PENDING" });
    expect(await bal(CHIDI)).toBe(0n);
    ids.overcap = body.invoice.id;
  });

  it("wrong rate -> ESCALATE", async () => {
    const { body } = await upload("06-wrong-rate.pdf");
    expect(body.invoice).toMatchObject({ decision: "ESCALATE", status: "ESCALATED" });
  });

  it("future due date -> SCHEDULE (held in the app DB)", async () => {
    const { body } = await upload("07-future-due.pdf");
    expect(body.invoice).toMatchObject({ decision: "SCHEDULE", status: "SCHEDULED", payOn: "2026-10-19" });
    ids.future = body.invoice.id;
  });

  it("large supplies order at the agreed rate -> Pending on chain", async () => {
    const { body } = await upload("08-supplies-large.pdf");
    expect(body.invoice).toMatchObject({ decision: "ASK", status: "ONCHAIN_PENDING" });
    ids.large = body.invoice.id;
  });

  it("unknown payee and unreadable photo never pay", async () => {
    expect((await upload("09-unknown-payee.pdf")).body.invoice).toMatchObject({ decision: "ESCALATE", status: "ESCALATED" });
    const photo = (await upload("10-photo.png")).body.invoice;
    expect(["REJECT", "ESCALATE", "ASK"]).toContain(photo.decision);
    expect(photo.txHash).toBeNull();
  });

  it("pending approvals list shows both parked payments with the EIP-712 domain", async () => {
    const a = (await (await R.approvals.GET(req("/api/approvals"))).json()) as { items: { paymentId: Hex; invoiceId: string; overLimits: number }[]; eip712: { name: string; chainId: number } };
    expect(a.eip712).toMatchObject({ name: "Payday SpendPolicy", chainId: 31337 });
    expect(a.items.map((i) => i.invoiceId).sort()).toEqual([ids.overcap, ids.large].sort());
    expect(a.items.every((i) => (i.overLimits & 1) === 1)).toBe(true);
  });

  it("owner approves the over-cap payment by EIP-712 signature; the agent relays it", async () => {
    const inv = ((await (await R.invoice.GET(req(`/api/invoices/${ids.overcap}`), ctx(ids.overcap))).json()) as { invoice: { paymentId: Hex; amountUnits: string } }).invoice;
    const nonce = 42n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const p = (await pub().readContract({ address: policy, abi: spendPolicyAbi, functionName: "getPayment", args: [inv.paymentId] })) as {
      payee: Address; amount: bigint; category: Hex; reasonHash: Hex; expiresAt: bigint; invoiceKey: Hex; agentEpoch: number;
    };
    expect(p.payee).toBe(CHIDI);
    expect(p.amount).toBe(BigInt(inv.amountUnits));
    expect(p.invoiceKey).not.toBe(`0x${"0".repeat(64)}`); // on-chain invoice dedup key is set (L-01)
    const ownerEpoch = BigInt((await pub().readContract({ address: policy, abi: spendPolicyAbi, functionName: "ownerEpoch" })) as number);
    expect(ownerEpoch).toBe(1n);
    const message = approvalMessage({ paymentId: inv.paymentId, ...p, expiresAt: BigInt(p.expiresAt) }, ownerEpoch, nonce, deadline);
    const types = APPROVE_TYPES;
    const domain = approvalDomain(31337, policy);
    // The browser-side typed data hashes to exactly what the contract verifies.
    const { hashTypedData } = await import("viem");
    const onchainDigest = await pub().readContract({ address: policy, abi: spendPolicyAbi, functionName: "approvalDigest", args: [inv.paymentId, nonce, deadline] });
    expect(hashTypedData({ domain, types, primaryType: "ApprovePending", message })).toBe(onchainDigest);
    // A signature under a stale ownerEpoch (audit L-04) is refused before relaying.
    const stale = await owner.signTypedData({ domain, types, primaryType: "ApprovePending", message: { ...message, ownerEpoch: 0n } });
    const badEpoch = await R.relay.POST(req("/api/approvals/relay", jsonBody({ paymentId: inv.paymentId, nonce: "42", deadline: deadline.toString(), signature: stale })));
    expect(badEpoch.status).toBe(400);

    // A signature from anyone but the owner is refused before anything is relayed.
    const forged = await outsider.signTypedData({ domain, types, primaryType: "ApprovePending", message });
    const bad = await R.relay.POST(req("/api/approvals/relay", jsonBody({ paymentId: inv.paymentId, nonce: "42", deadline: deadline.toString(), signature: forged })));
    expect(bad.status).toBe(400);

    const signature = await owner.signTypedData({ domain, types, primaryType: "ApprovePending", message });
    const res = await R.relay.POST(req("/api/approvals/relay", jsonBody({ paymentId: inv.paymentId, nonce: "42", deadline: deadline.toString(), signature })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("Executed"); // PaymentApproved + PaymentExecuted
    expect(await bal(CHIDI)).toBe(1450n * U);
    const after = (await (await R.invoice.GET(req(`/api/invoices/${ids.overcap}`), ctx(ids.overcap))).json()) as { invoice: { status: string } };
    expect(after.invoice.status).toBe("EXECUTED");
  });

  it("owner rejects the large order with a direct wallet tx (rejectPending)", async () => {
    const inv = ((await (await R.invoice.GET(req(`/api/invoices/${ids.large}`), ctx(ids.large))).json()) as { invoice: { paymentId: Hex } }).invoice;
    const hash = await wallet(owner).writeContract({ address: policy, abi: spendPolicyAbi, functionName: "rejectPending", args: [inv.paymentId] });
    await pub().waitForTransactionReceipt({ hash });
    const a = (await (await R.approvals.GET(req("/api/approvals"))).json()) as { items: unknown[] };
    expect(a.items).toHaveLength(0);
    const after = (await (await R.invoice.GET(req(`/api/invoices/${ids.large}`), ctx(ids.large))).json()) as { invoice: { status: string } };
    expect(after.invoice.status).toBe("REJECTED");
    expect(await bal(PAPER)).toBe(0n);
  });

  it("owner can dismiss an escalated invoice", async () => {
    const r = await R.resolve.POST(req(`/api/invoices/${ids.injection}/resolve`, jsonBody({ action: "dismiss" })), ctx(ids.injection));
    expect(((await r.json()) as { invoice: { status: string } }).invoice.status).toBe("DISMISSED");
    const c = await R.resolve.POST(req(`/api/invoices/${ids.normal}/resolve`, jsonBody({ action: "confirm" })), ctx(ids.normal));
    expect(c.status).toBe(409);
  });

  it("scheduler: wrong secret refused; on the pay-on date the scheduled bill is re-evaluated and paid", async () => {
    expect((await R.cron.POST(req("/api/cron/due", { method: "POST", cookie: null, headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    const early = (await (await R.cron.POST(req("/api/cron/due", { method: "POST", cookie: null, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))).json()) as { processed: unknown[] };
    expect(early.processed).toHaveLength(0);
    R.clock.setClockForTests(() => new Date("2026-10-19T08:00:00Z"));
    const due = (await (await R.cron.POST(req("/api/cron/due", { method: "POST", cookie: null, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))).json()) as { processed: { id: string; status: string }[] };
    expect(due.processed).toEqual([expect.objectContaining({ id: ids.future, decision: "PAY_NOW", status: "EXECUTED" })]);
    expect(await bal(PAPER)).toBe(150n * U);
  });

  it("decision log is rebuilt from events and every reason doc verifies against reasonHash", async () => {
    const { entries } = (await (await R.log.GET(req("/api/log"))).json()) as { entries: { eventName: string; verified: boolean }[] };
    const names = entries.map((e) => e.eventName);
    expect(names.filter((n) => n === "PaymentExecuted")).toHaveLength(3);
    expect(names.filter((n) => n === "PaymentPending")).toHaveLength(2);
    expect(names).toContain("PaymentApproved");
    expect(names).toContain("PaymentRejected");
    expect(entries.every((e) => e.verified)).toBe(true);
  });

  it("public stats count only PaymentExecuted events", async () => {
    R.events.clearStatsCacheForTests();
    const s = (await (await R.stats.GET(req("/api/stats", { cookie: null }))).json()) as { transactions: number; volumeUnits: string; businesses: number; payees: number };
    expect(s).toMatchObject({ transactions: 3, volumeUnits: (2400n * U).toString(), businesses: 1, payees: 3 });
  });

  it("policy overview reflects on-chain state", async () => {
    const o = (await (await R.policy.GET(req("/api/policy"))).json()) as { totalPaid: string; balance: string; agent: string };
    expect(o).toMatchObject({ totalPaid: (2400n * U).toString(), balance: (7600n * U).toString(), agent: agent.address });
  });
});

describe("e2e: multi-tenant onboarding through SpendPolicyFactory", () => {
  const ARC_USDC = "0x3600000000000000000000000000000000000000" as Address;
  let factory: Address;
  let tenantPolicy: Address;
  let createTx: Hex;
  let tenantCookie = "";
  const demoCookie = () => cookie;

  it("factory deploys; a new business creates its OWN policy from its own wallet", async () => {
    const pc = pub();
    // The factory hard-codes Arc USDC; put the 6-decimal mock's code there on anvil.
    const tok = JSON.parse(readFileSync(join(ROOT, "out", "MockUSDC.sol", "MockUSDC.json"), "utf8"));
    await pc.request({ method: "anvil_setCode" as never, params: [ARC_USDC, tok.deployedBytecode.object] as never });
    const f = artifact("SpendPolicyFactory.sol", "SpendPolicyFactory");
    const h = await wallet(owner).deployContract({ abi: f.abi, bytecode: f.bytecode });
    factory = getAddress((await pc.waitForTransactionReceipt({ hash: h })).contractAddress!);
    process.env.PAYDAY_FACTORY_ADDRESS = factory;

    const cfg = (await (await R.tenants.GET(req(`/api/tenants?owner=${outsider.address}`, { cookie: null }))).json()) as {
      factory: string; hostedAgent: string; existing: unknown; defaults: { perPaymentUsdc: string };
    };
    expect(cfg).toMatchObject({ factory, hostedAgent: agent.address, existing: null, defaults: { perPaymentUsdc: "20" } });

    createTx = await wallet(outsider).writeContract({
      address: factory, abi: spendPolicyFactoryAbi, functionName: "createPolicy",
      args: [agent.address, 20n * U, 100n * U, 200n * U, 7n * 86400n],
    });
    await pc.waitForTransactionReceipt({ hash: createTx });
    const list = await pc.readContract({ address: factory, abi: spendPolicyFactoryAbi, functionName: "policiesOf", args: [outsider.address] });
    tenantPolicy = list[0]!;
    expect(await pc.readContract({ address: tenantPolicy, abi: spendPolicyAbi, functionName: "owner" })).toBe(outsider.address);
  });

  it("registration is verified on chain: non-factory policy and wrong tx are refused", async () => {
    R.rate.resetRateLimitsForTests();
    const post = (b: unknown) => R.tenants.POST(req("/api/tenants", { ...jsonBody(b), cookie: null }));
    expect((await post({ policy: policy, txHash: createTx })).status).toBe(400); // demo policy: not from the factory
    expect((await post({ policy: tenantPolicy, txHash: "0x" + "11".repeat(32) })).status).toBe(400);
    const ok = await post({ policy: tenantPolicy, txHash: createTx });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ owner: outsider.address, policy: tenantPolicy, agent: agent.address });
  });

  it("the new owner signs in and sees ONLY their own policy, invoices and payees", async () => {
    const { res } = await signIn(outsider);
    expect(res.status).toBe(200);
    tenantCookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const as = (path: string) => req(path, { cookie: tenantCookie });
    expect(await (await R.me.GET(as("/api/auth/me"))).json()).toMatchObject({ address: outsider.address, policy: tenantPolicy });
    const o = (await (await R.policy.GET(as("/api/policy"))).json()) as { policy: string; owner: string; perPaymentCap: string };
    expect(o).toMatchObject({ policy: tenantPolicy, owner: outsider.address, perPaymentCap: (20n * U).toString() });
    expect(((await (await R.invoices.GET(as("/api/invoices"))).json()) as { invoices: unknown[] }).invoices).toHaveLength(0);
    expect(((await (await R.payees.GET(as("/api/payees"))).json()) as { payees: unknown[] }).payees).toHaveLength(0);
    expect(((await (await R.approvals.GET(as("/api/approvals"))).json()) as { items: unknown[] }).items).toHaveLength(0);
    expect((await R.invoice.GET(as(`/api/invoices/${ids.normal}`), ctx(ids.normal))).status).toBe(404);
  });

  it("tenant uploads never touch the demo policy; the demo owner still sees only the demo policy", async () => {
    const before = await bal(ADEBAYO);
    const fd = new FormData();
    fd.set("file", new File([readFileSync(join(FIX, "01-normal.pdf"))], "01-normal.pdf", { type: "application/pdf" }));
    const res = await R.invoices.POST(req("/api/invoices", { method: "POST", body: fd, ip: "10.9.9.9", cookie: tenantCookie }));
    expect(res.status).toBe(201);
    const inv = ((await res.json()) as { invoice: { decision: string; status: string } }).invoice;
    expect(inv.status).not.toBe("EXECUTED"); // payee is not on THIS tenant's allow-list
    expect(await bal(ADEBAYO)).toBe(before);
    const mine = ((await (await R.invoices.GET(req("/api/invoices", { cookie: tenantCookie }))).json()) as { invoices: unknown[] }).invoices;
    expect(mine).toHaveLength(1);
    const demo = (await (await R.policy.GET(req("/api/policy", { cookie: demoCookie() }))).json()) as { policy: string };
    expect(demo.policy).toBe(getAddress(policy));
    const demoInv = ((await (await R.invoices.GET(req("/api/invoices", { cookie: demoCookie() }))).json()) as { invoices: { id: string }[] }).invoices;
    expect(demoInv.length).toBeGreaterThan(1);
    expect(demoInv.some((i) => i.id === ids.normal)).toBe(true);
    expect((await (await R.tenants.GET(req(`/api/tenants?owner=${outsider.address}`, { cookie: null }))).json())).toMatchObject({ existing: { policy: tenantPolicy } });
  });
});

