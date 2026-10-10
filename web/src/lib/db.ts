import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "./config";
import { activePolicy } from "./tenant";

/**
 * App database: SQLite through Node's built-in `node:sqlite` (Node >= 22.13), so there is no
 * native addon to compile on Windows. One file (PAYDAY_DB_PATH). It holds ONLY app-side data:
 * invoices + decisions, reason documents, owner-set payee terms, auth nonces, the schedule.
 * Money state always comes from the chain.
 */
let db: DatabaseSync | null = null;
let dbPath: string | null = null;

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  extraction_json TEXT,
  extraction_error TEXT,
  injection_json TEXT NOT NULL DEFAULT '[]',
  payee_address TEXT,
  payment_id TEXT,
  amount_units TEXT,
  invoice_number_norm TEXT,
  due_date TEXT,
  decision TEXT,
  status TEXT NOT NULL,
  pay_on TEXT,
  reason_hash TEXT,
  explanation TEXT,
  tx_hash TEXT,
  milestone TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS invoices_payment_id ON invoices(payment_id);
CREATE INDEX IF NOT EXISTS invoices_payee ON invoices(payee_address, invoice_number_norm);
CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status, pay_on);
CREATE TABLE IF NOT EXISTS reason_docs (
  reason_hash TEXT PRIMARY KEY,
  payment_id TEXT,
  invoice_id TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reason_docs_payment ON reason_docs(payment_id);
CREATE TABLE IF NOT EXISTS payees (
  address TEXT PRIMARY KEY,
  identifiers_json TEXT NOT NULL DEFAULT '[]',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  bank_details TEXT,
  terms_json TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
  owner_address TEXT PRIMARY KEY,
  policy_address TEXT NOT NULL UNIQUE,
  agent_address TEXT NOT NULL,
  deploy_block TEXT NOT NULL DEFAULT '0',
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payee_terms (
  policy_address TEXT NOT NULL,
  address TEXT NOT NULL,
  identifiers_json TEXT NOT NULL DEFAULT '[]',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  bank_details TEXT,
  terms_json TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (policy_address, address)
);
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`;

export function getDb(): DatabaseSync {
  const p = serverConfig().PAYDAY_DB_PATH;
  if (db && dbPath === p) return db;
  if (p !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(MIGRATIONS);
  migrateTenancy(db, serverConfig().PAYDAY_POLICY_ADDRESS);
  dbPath = p;
  return db;
}

/**
 * Multi-tenant migration (idempotent): invoices get a policy_address column, and rows created
 * before tenancy (plus the legacy single-tenant payees table) belong to the configured demo policy.
 */
function migrateTenancy(d: DatabaseSync, demoPolicy: string) {
  const cols = d.prepare("PRAGMA table_info(invoices)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "policy_address")) d.exec("ALTER TABLE invoices ADD COLUMN policy_address TEXT");
  d.prepare("UPDATE invoices SET policy_address = ? WHERE policy_address IS NULL").run(demoPolicy);
  d.exec("CREATE INDEX IF NOT EXISTS invoices_policy ON invoices(policy_address, created_at)");
  d.prepare(
    `INSERT OR IGNORE INTO payee_terms (policy_address, address, identifiers_json, aliases_json, bank_details, terms_json, updated_at, updated_by)
     SELECT ?, address, identifiers_json, aliases_json, bank_details, terms_json, updated_at, updated_by FROM payees`,
  ).run(demoPolicy);
  d.exec("DELETE FROM payees");
}

/** Test helper: drop the cached handle (e.g. after changing PAYDAY_DB_PATH). */
export function resetDbForTests() {
  db?.close();
  db = null;
  dbPath = null;
}

export interface InvoiceRow {
  id: string;
  created_at: string;
  updated_at: string;
  file_sha256: string;
  file_name: string;
  media_type: string;
  size_bytes: number;
  extraction_json: string | null;
  extraction_error: string | null;
  injection_json: string;
  payee_address: string | null;
  payment_id: string | null;
  amount_units: string | null;
  invoice_number_norm: string | null;
  due_date: string | null;
  decision: string | null;
  status: string;
  pay_on: string | null;
  reason_hash: string | null;
  explanation: string | null;
  tx_hash: string | null;
  milestone: string | null;
  last_error: string | null;
  policy_address: string | null;
}

export type InvoiceStatus =
  | "EXTRACTION_FAILED"
  | "SCHEDULED"
  | "AWAITING_OWNER"
  | "SUBMITTING"
  | "ONCHAIN_PENDING"
  | "EXECUTED"
  | "ESCALATED"
  | "REJECTED"
  | "DISMISSED"
  | "FAILED";

/** Invoice by id, ONLY if it belongs to the active tenant's policy. */
export function getInvoice(id: string): InvoiceRow | undefined {
  return getDb().prepare("SELECT * FROM invoices WHERE id = ? AND policy_address = ?").get(id, activePolicy()) as InvoiceRow | undefined;
}

export function listInvoices(limit = 200): InvoiceRow[] {
  return getDb()
    .prepare("SELECT * FROM invoices WHERE policy_address = ? ORDER BY created_at DESC LIMIT ?")
    .all(activePolicy(), limit) as unknown as InvoiceRow[];
}

// ------------------------------------------------------------------ tenants

export interface TenantRow {
  owner_address: string;
  policy_address: string;
  agent_address: string;
  deploy_block: string;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

export function getTenantByOwner(owner: string): TenantRow | undefined {
  return getDb().prepare("SELECT * FROM tenants WHERE owner_address = ?").get(owner) as TenantRow | undefined;
}

export function getTenantByPolicy(policy: string): TenantRow | undefined {
  return getDb().prepare("SELECT * FROM tenants WHERE policy_address = ?").get(policy) as TenantRow | undefined;
}

/** owner -> policy (one active policy per owner; re-registering replaces it). */
export function upsertTenant(t: { owner: string; policy: string; agent: string; deployBlock: bigint; txHash: string | null }) {
  const ts = new Date().toISOString();
  const d = getDb();
  // A policy can belong to only one owner row (ownership may have been transferred on chain).
  d.prepare("DELETE FROM tenants WHERE policy_address = ? AND owner_address != ?").run(t.policy, t.owner);
  d.prepare(
    `INSERT INTO tenants (owner_address, policy_address, agent_address, deploy_block, tx_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_address) DO UPDATE SET policy_address=excluded.policy_address, agent_address=excluded.agent_address,
       deploy_block=excluded.deploy_block, tx_hash=excluded.tx_hash, updated_at=excluded.updated_at`,
  ).run(t.owner, t.policy, t.agent, t.deployBlock.toString(), t.txHash, ts, ts);
}

export function updateInvoice(id: string, fields: Partial<InvoiceRow>) {
  const keys = Object.keys(fields).filter((k) => k !== "id" && k !== "policy_address");
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null);
  getDb()
    .prepare(`UPDATE invoices SET ${sets}, updated_at = ? WHERE id = ? AND policy_address = ?`)
    .run(...values, new Date().toISOString(), id, activePolicy());
}
