import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { spendPolicyAbi } from "./abi";
import { publicClient, readChainState, readPolicyOverview } from "./chain";
import { now } from "./clock";
import { serverConfig } from "./config";
import { getDb, getInvoice, updateInvoice, type InvoiceRow, type InvoiceStatus } from "./db";
import { decide, ENGINE_VERSION } from "./decision/engine";
import { matchPayee } from "./decision/match";
import type { ChainState, DecisionResult, HistoryFacts, ReasonCode } from "./decision/types";
import { getExecutor } from "./executor";
import { explainDecision } from "./explain";
import { computeInvoiceKey, computePaymentId, normalizeRef, reasonHashOf } from "./ids";
import { scanForInjection, type InjectionFlag } from "./injection";
import { extractInvoice } from "./invoice/extract";
import { extractPdfText } from "./invoice/pdf-text";
import { validateExtraction, type InvoiceExtraction } from "./invoice/schema";
import { validateUpload } from "./invoice/upload";
import { getModel } from "./llm/provider";
import { toUnits } from "./money";
import { outcomeFromReceipt } from "./receipts";
import { loadRegistry } from "./registry";
import { activePolicy, withPolicy } from "./tenant";

const COMMITTED: InvoiceStatus[] = ["SCHEDULED", "AWAITING_OWNER", "ONCHAIN_PENDING", "SUBMITTING"];

/** Step 1: validate + extract + screen. Never acts. */
export async function intakeUpload(file: { bytes: Uint8Array; declaredType: string; fileName: string }) {
  const cfg = serverConfig();
  const mediaType = validateUpload(file.bytes, file.declaredType, cfg.PAYDAY_MAX_UPLOAD_BYTES);
  const id = randomUUID();
  const sha = createHash("sha256").update(file.bytes).digest("hex");
  const fileName = file.fileName.replace(/[^\w.\- ]/g, "_").slice(0, 120) || "invoice";

  const extraction = await extractInvoice(getModel("extract"), { bytes: file.bytes, mediaType, filename: fileName });
  const rawText = mediaType === "application/pdf" ? extractPdfText(file.bytes) : "";
  const flags: InjectionFlag[] = [];
  if (extraction.ok) {
    const v = extraction.value;
    flags.push(
      ...scanForInjection({
        payeeName: v.payeeName,
        payeeIdentifier: v.payeeIdentifier,
        payeeBankDetails: v.payeeBankDetails,
        payeeWalletAddress: v.payeeWalletAddress,
        invoiceNumber: v.invoiceNumber,
        otherText: v.otherText,
        lineItems: v.lineItems.map((l) => l.description).join("\n"),
      }),
    );
  }
  for (const f of scanForInjection({ rawText })) {
    if (!flags.some((x) => x.rule === f.rule && x.match === f.match)) flags.push(f);
  }

  const ts = now().toISOString();
  getDb()
    .prepare(
      `INSERT INTO invoices (id, created_at, updated_at, file_sha256, file_name, media_type, size_bytes,
        extraction_json, extraction_error, injection_json, status, policy_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ts,
      ts,
      sha,
      fileName,
      mediaType,
      file.bytes.byteLength,
      extraction.ok ? JSON.stringify(extraction.value) : null,
      extraction.ok ? null : extraction.error,
      JSON.stringify(flags),
      extraction.ok ? "ESCALATED" : "EXTRACTION_FAILED", // provisional; evaluate() sets the real status
      activePolicy(),
    );
  return id;
}

function historyFor(row: InvoiceRow, payee: Address, amount: bigint, paymentId: Hex, invNo: string): HistoryFacts {
  const db = getDb();
  const dupe = db
    .prepare(`SELECT status FROM invoices WHERE payment_id = ? AND id != ? AND status IN ('SUBMITTING','ONCHAIN_PENDING','EXECUTED','SCHEDULED','AWAITING_OWNER') AND policy_address = ? LIMIT 1`)
    .get(paymentId, row.id, activePolicy()) as { status: string } | undefined;
  const same = db
    .prepare(`SELECT amount_units, status FROM invoices WHERE payee_address = ? AND invoice_number_norm = ? AND id != ? AND policy_address = ?`)
    .all(payee, invNo, row.id, activePolicy()) as { amount_units: string; status: string }[];
  const since = new Date(now().getTime() - 20 * 86_400_000).toISOString();
  const recent = db
    .prepare(
      `SELECT invoice_number_norm, created_at FROM invoices WHERE payee_address = ? AND amount_units = ? AND id != ?
       AND invoice_number_norm != ? AND created_at >= ? AND status NOT IN ('REJECTED','DISMISSED','ESCALATED') AND policy_address = ?`,
    )
    .all(payee, amount.toString(), row.id, invNo, since, activePolicy()) as { invoice_number_norm: string; created_at: string }[];
  const milestones = db
    .prepare(`SELECT milestone FROM invoices WHERE payee_address = ? AND milestone IS NOT NULL AND id != ? AND status IN ('EXECUTED','ONCHAIN_PENDING','SUBMITTING') AND policy_address = ?`)
    .all(payee, row.id, activePolicy()) as { milestone: string }[];
  return {
    paymentIdInDb: dupe?.status ?? null,
    sameInvoiceNumber: same.map((s) => ({ amountUnits: BigInt(s.amount_units), status: s.status })),
    sameAmountRecent: recent.map((r) => ({
      invoiceNumber: r.invoice_number_norm,
      daysAgo: Math.floor((now().getTime() - Date.parse(r.created_at)) / 86_400_000),
    })),
    paidMilestones: milestones.map((m) => m.milestone),
  };
}

function committedOutflow(excludeId: string): bigint {
  const rows = getDb()
    .prepare(`SELECT amount_units FROM invoices WHERE id != ? AND amount_units IS NOT NULL AND status IN (${COMMITTED.map(() => "?").join(",")}) AND policy_address = ?`)
    .all(excludeId, ...COMMITTED, activePolicy()) as { amount_units: string }[];
  return rows.reduce((s, r) => s + BigInt(r.amount_units), 0n);
}

export interface EvaluateOptions {
  ownerAcknowledged?: ReasonCode[];
  confirmedBy?: Address | null;
}

/** Step 2: deterministic decision + (maybe) on-chain submission. Safe to re-run. */
export async function evaluateInvoice(id: string, opts: EvaluateOptions = {}) {
  const row = getInvoice(id);
  if (!row) throw new Error("invoice not found");
  const cfg = serverConfig();
  const today = now().toISOString().slice(0, 10);

  let inv: InvoiceExtraction | null = null;
  if (row.extraction_json) {
    const v = validateExtraction(JSON.parse(row.extraction_json));
    inv = v.ok ? v.value : null;
  }
  const injection = JSON.parse(row.injection_json) as InjectionFlag[];
  let amountUnits: bigint | null = null;
  try {
    amountUnits = inv ? toUnits(inv.amount) : null;
  } catch {
    amountUnits = null;
  }

  const registry = inv ? await loadRegistry() : [];
  const match = inv ? matchPayee(inv, registry) : null;
  let paymentId: Hex | null = null;
  let invoiceKey: Hex | null = null;
  let chain: ChainState | null = null;
  let history: HistoryFacts = { paymentIdInDb: null, sameInvoiceNumber: [], sameAmountRecent: [], paidMilestones: [] };
  const invNo = inv ? normalizeRef(inv.invoiceNumber) : "";

  if (inv && match?.status === "matched" && amountUnits && amountUnits > 0n && invNo) {
    const chainId = await publicClient().getChainId();
    paymentId = computePaymentId({ chainId, policy: activePolicy(), payee: match.entry.address, amount: amountUnits, invoiceNumber: inv.invoiceNumber });
    invoiceKey = computeInvoiceKey({ chainId, policy: activePolicy(), payee: match.entry.address, invoiceNumber: inv.invoiceNumber });
    chain = await readChainState({ payee: match.entry.address, category: match.entry.category, paymentId });
    history = historyFor(row, match.entry.address, amountUnits, paymentId, invNo);
  }

  const result = decide({
    today,
    invoice: inv,
    extractionError: row.extraction_error,
    injection,
    match,
    amountUnits,
    chain,
    history,
    scheduledOutflowUnits: committedOutflow(row.id),
    config: {
      scheduleLeadDays: cfg.PAYDAY_SCHEDULE_LEAD_DAYS,
      runwayBufferUnits: toUnits(cfg.PAYDAY_RUNWAY_BUFFER_USDC),
      acceptedCurrencies: ["USD", "USDC"],
    },
    ownerAcknowledged: opts.ownerAcknowledged ?? [],
  });

  const payee = match?.status === "matched" ? match.entry : null;
  const doc = {
    v: 1,
    engine: ENGINE_VERSION,
    invoiceId: row.id,
    evaluatedAt: now().toISOString(),
    paymentId,
    decision: result.decision,
    reasons: result.reasons,
    invoice: inv
      ? {
          fileSha256: row.file_sha256,
          invoiceNumber: inv.invoiceNumber,
          payeeName: inv.payeeName,
          payeeIdentifier: inv.payeeIdentifier,
          amount: inv.amount,
          currency: inv.currency,
          dueDate: inv.dueDate,
        }
      : { fileSha256: row.file_sha256 },
    payee: payee ? { address: payee.address, label: payee.label, category: payee.category } : null,
    injectionRules: [...new Set(injection.map((f) => f.rule))].sort(),
    ownerConfirmation: opts.confirmedBy ? { by: opts.confirmedBy, codes: [...(opts.ownerAcknowledged ?? [])].sort() } : null,
  };
  const { canonical, hash: reasonHash } = reasonHashOf(doc);
  getDb()
    .prepare("INSERT OR IGNORE INTO reason_docs (reason_hash, payment_id, invoice_id, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(reasonHash, paymentId, row.id, canonical, now().toISOString());

  const explanation = await explainDecision(result);
  const base: Partial<InvoiceRow> = {
    decision: result.decision,
    reason_hash: reasonHash,
    payment_id: paymentId,
    payee_address: payee?.address ?? null,
    amount_units: amountUnits?.toString() ?? null,
    invoice_number_norm: invNo || null,
    due_date: inv?.dueDate ?? null,
    pay_on: result.payOn,
    explanation,
    milestone: result.matchedMilestone,
    last_error: null,
  };

  if (result.action !== "submit" || !payee || !paymentId || !invoiceKey || !amountUnits) {
    const status: InvoiceStatus = !inv
      ? "EXTRACTION_FAILED"
      : result.decision === "SCHEDULE"
        ? "SCHEDULED"
        : result.decision === "ASK"
          ? "AWAITING_OWNER"
          : result.decision === "REJECT"
            ? "REJECTED"
            : "ESCALATED";
    updateInvoice(id, { ...base, status });
    return { id, result, reasonHash, paymentId, status };
  }

  // ---- submission. Synchronous re-check + mark (no await in between) so two concurrent
  // evaluations in this process cannot both submit the same paymentId.
  const clash = getDb()
    .prepare(`SELECT 1 FROM invoices WHERE payment_id = ? AND id != ? AND status IN ('SUBMITTING','ONCHAIN_PENDING','EXECUTED') AND policy_address = ?`)
    .get(paymentId, id, activePolicy());
  if (clash) {
    updateInvoice(id, { ...base, decision: "REJECT", status: "REJECTED", last_error: "duplicate paymentId in flight" });
    return { id, result, reasonHash, paymentId, status: "REJECTED" as InvoiceStatus };
  }
  updateInvoice(id, { ...base, status: "SUBMITTING" });
  return submit(id, result, { paymentId, payee: payee.address, category: payee.category, amount: amountUnits, reasonHash, invoiceKey });
}

async function submit(
  id: string,
  result: DecisionResult,
  req: { paymentId: Hex; payee: Address; category: Hex; amount: bigint; reasonHash: Hex; invoiceKey: Hex },
) {
  const policy = activePolicy();
  try {
    const executor = await getExecutor();
    if (!executor) throw new Error("dry run: PAYDAY_EXECUTOR=none, nothing submitted");
    const agent = await executor.agentAddress();
    const overview = await readPolicyOverview();
    if (overview.agent !== agent) throw new Error("configured agent wallet is not the policy's agent");
    // On-chain invoice dedup (audit L-01): the same payee + invoice number is already Pending or
    // Executed under another paymentId (e.g. a re-sent invoice with an altered amount).
    const holder = (await publicClient().readContract({ address: policy, abi: spendPolicyAbi, functionName: "invoicePayment", args: [req.invoiceKey] })) as Hex;
    if (!/^0x0{64}$/.test(holder) && holder.toLowerCase() !== req.paymentId.toLowerCase()) {
      updateInvoice(id, { decision: "REJECT", status: "REJECTED", last_error: `duplicate invoice: already held on chain by ${holder}` });
      return { id, result, reasonHash: req.reasonHash, paymentId: req.paymentId, status: "REJECTED" as InvoiceStatus };
    }
    // Simulate first: a revert (blocklist, race on caps/ceiling) costs nothing here.
    await publicClient().simulateContract({
      account: agent,
      address: policy,
      abi: spendPolicyAbi,
      functionName: "requestPayment",
      args: [req.paymentId, req.payee, req.amount, req.category, req.reasonHash, req.invoiceKey],
    });
    const { txHash } = await executor.requestPayment(req);
    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${txHash}`);
    const outcome = outcomeFromReceipt(receipt, policy, req.paymentId);
    const status: InvoiceStatus = outcome === "Executed" ? "EXECUTED" : outcome === "Pending" ? "ONCHAIN_PENDING" : "FAILED";
    updateInvoice(id, { status, tx_hash: txHash, last_error: status === "FAILED" ? "no policy event for paymentId" : null });
    return { id, result, reasonHash: req.reasonHash, paymentId: req.paymentId, status };
  } catch (e) {
    const msg = (e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : "submit failed").slice(0, 300);
    updateInvoice(id, { status: "FAILED", last_error: msg });
    return { id, result, reasonHash: req.reasonHash, paymentId: req.paymentId, status: "FAILED" as InvoiceStatus };
  }
}

/** Keep app rows in sync with on-chain outcomes of pending payments (approved/rejected/...). */
export async function syncOnchainStatuses() {
  const rows = getDb().prepare("SELECT id, payment_id FROM invoices WHERE status = 'ONCHAIN_PENDING' AND payment_id IS NOT NULL AND policy_address = ?").all(activePolicy()) as {
    id: string;
    payment_id: Hex;
  }[];
  // 4 = Cancelled is no longer reachable on chain (agent cancel removed, audit L-06); kept for old policies.
  const map: Record<number, InvoiceStatus> = { 2: "EXECUTED", 3: "REJECTED", 4: "DISMISSED", 5: "DISMISSED" };
  for (const r of rows) {
    const p = (await publicClient().readContract({
      address: activePolicy(),
      abi: spendPolicyAbi,
      functionName: "getPayment",
      args: [r.payment_id],
    })) as { status: number };
    const s = map[Number(p.status)];
    if (s) updateInvoice(r.id, { status: s });
  }
}

/**
 * Scheduler: re-evaluate every SCHEDULED invoice whose pay-on date has arrived.
 * With a bound tenant (owner-triggered) only that policy; from cron, every policy, each in its own scope.
 */
export async function runDueSchedule(opts: { allTenants?: boolean } = {}) {
  const today = now().toISOString().slice(0, 10);
  const policies = opts.allTenants
    ? (getDb()
        .prepare("SELECT DISTINCT policy_address AS p FROM invoices WHERE (status = 'SCHEDULED' AND pay_on <= ?) OR status = 'ONCHAIN_PENDING'")
        .all(today) as { p: string }[]).map((r) => getAddress(r.p))
    : [activePolicy()];
  const results: Awaited<ReturnType<typeof evaluateInvoice>>[] = [];
  for (const policy of policies) {
    // One tenant's RPC/LLM/executor failure must not stop scheduled payments for the others (F-4).
    try {
      await withPolicy(policy, async () => {
        await syncOnchainStatuses();
        const due = getDb()
          .prepare("SELECT id FROM invoices WHERE status = 'SCHEDULED' AND pay_on <= ? AND policy_address = ? ORDER BY pay_on")
          .all(today, policy) as { id: string }[];
        for (const d of due) {
          try {
            results.push(await evaluateInvoice(d.id));
          } catch (e) {
            if (!opts.allTenants) throw e;
            console.error("[payday] scheduler invoice error:", policy, d.id, e instanceof Error ? e.message : "unknown");
          }
        }
      });
    } catch (e) {
      if (!opts.allTenants) throw e;
      console.error("[payday] scheduler tenant error:", policy, e instanceof Error ? e.message : "unknown");
    }
  }
  return results.map((r) => ({ id: r.id, decision: r.result.decision, status: r.status }));
}
