import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "./config";

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
  dbPath = p;
  return db;
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

export function getInvoice(id: string): InvoiceRow | undefined {
  return getDb().prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
}

export function listInvoices(limit = 200): InvoiceRow[] {
  return getDb().prepare("SELECT * FROM invoices ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as InvoiceRow[];
}

export function updateInvoice(id: string, fields: Partial<InvoiceRow>) {
  const keys = Object.keys(fields).filter((k) => k !== "id");
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null);
  getDb()
    .prepare(`UPDATE invoices SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), id);
}
