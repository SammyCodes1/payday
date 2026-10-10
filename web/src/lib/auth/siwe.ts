import "server-only";
import { getAddress } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { getDb } from "../db";
import { publicClient, currentOwner } from "../chain";
import { serverConfig } from "../config";
import { HttpError } from "./guard";

/** Sign-In With Ethereum (EIP-4361). Nonces are single-use and expire after 10 minutes. */
export function issueNonce(): string {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const db = getDb();
  db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO auth_nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, Date.now() + 10 * 60_000);
  return nonce;
}

export async function verifySiwe(message: string, signature: `0x${string}`) {
  if (message.length > 4000) throw new HttpError(400, "message too long");
  const parsed = parseSiweMessage(message);
  const origin = new URL(serverConfig().PAYDAY_APP_ORIGIN);
  if (!parsed.nonce || !parsed.address) throw new HttpError(400, "malformed SIWE message");
  const db = getDb();
  const row = db.prepare("SELECT expires_at, used FROM auth_nonces WHERE nonce = ?").get(parsed.nonce) as
    | { expires_at: number; used: number }
    | undefined;
  if (!row || row.used || row.expires_at < Date.now()) throw new HttpError(401, "unknown or expired nonce");
  db.prepare("UPDATE auth_nonces SET used = 1 WHERE nonce = ?").run(parsed.nonce);

  const chainId = await publicClient().getChainId();
  if (!validateSiweMessage({ message: parsed, domain: origin.host, nonce: parsed.nonce }) || parsed.chainId !== chainId) {
    throw new HttpError(401, "SIWE message invalid for this app/chain");
  }
  // verifySiweMessage supports EOAs and smart accounts (ERC-1271 / ERC-6492).
  const ok = await publicClient().verifySiweMessage({ message, signature, domain: origin.host, nonce: parsed.nonce });
  if (!ok) throw new HttpError(401, "bad signature");
  const address = getAddress(parsed.address);
  if (address !== (await currentOwner())) throw new HttpError(403, "only the policy owner can sign in");
  return address;
}
