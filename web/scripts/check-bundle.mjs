#!/usr/bin/env node
// Bundle secret check. Builds the app into .next-canary with CANARY values for every secret env var,
// then proves that:
//   1. no canary value appears ANYWHERE in the build output (client or server: nothing is inlined);
//   2. no secret env var NAME, private-key-shaped hex, PEM block or the dev mnemonic appears in any
//      file shipped to the browser (.next-canary/static/**).
// Exit code 0 = clean. Canary values are random per run and are not secrets.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = ".next-canary";
const SECRET_VARS = [
  "SESSION_SECRET",
  "CRON_SECRET",
  "CIRCLE_API_KEY",
  "CIRCLE_ENTITY_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];
const tag = randomBytes(6).toString("hex");
const canary = Object.fromEntries(SECRET_VARS.map((v) => [v, `CANARY${tag}${v.replace(/_/g, "")}${randomBytes(12).toString("hex")}`]));

rmSync(DIST, { recursive: true, force: true });
console.log(`[bundle-check] building into ${DIST} with canary secrets (tag ${tag})…`);
const build = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...canary,
    NEXT_DIST_DIR: DIST,
    NEXT_TELEMETRY_DISABLED: "1",
    CIRCLE_AGENT_WALLET_ID: "00000000-0000-4000-8000-000000000000",
  },
});
if (build.status !== 0) {
  console.error("[bundle-check] build failed");
  process.exit(build.status ?? 1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "cache") continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const failures = [];
const all = walk(DIST);
const textual = (p) => /\.(js|mjs|cjs|json|html|css|map|txt|rsc|meta|body)$/.test(p) || !p.includes(".");
let scannedAll = 0;
for (const f of all.filter(textual)) {
  const s = readFileSync(f, "latin1");
  scannedAll++;
  for (const [k, v] of Object.entries(canary)) if (s.includes(v)) failures.push(`canary for ${k} inlined in ${f}`);
}

const clientDir = join(DIST, "static");
if (!existsSync(clientDir)) failures.push("no client output found");
const clientFiles = existsSync(clientDir) ? walk(clientDir) : [];
const patterns = [
  ...SECRET_VARS.map((v) => [new RegExp(`\\b${v}\\b`), `secret env name ${v}`]),
  [/\bCIRCLE_[A-Z_]+\b/, "CIRCLE_* env name"],
  [/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/, "32-byte hex (possible private key)"],
  [/-----BEGIN [A-Z ]*(PRIVATE KEY|RSA)/, "PEM private key block"],
  [/test test test test test test test test test test test junk/, "dev mnemonic"],
  [/@circle-fin\/developer-controlled-wallets|initiateDeveloperControlledWalletsClient/, "Circle server SDK"],
];
// 32-byte hex literals are allowed in client code ONLY if the identical literal is published in a
// dependency's source (curve orders, max uint256, event topics, ERC-6492 suffix, ...). Anything else
// (e.g. a private key that leaked via env or a hard-coded string) fails the check.
const libHex = new Set();
for (const dep of ["viem", "ox", "@noble", "@wagmi", "wagmi", "abitype", "@tanstack", "next", "react-dom"]) {
  const d = join("node_modules", dep);
  if (!existsSync(d)) continue;
  for (const f of walk(d)) {
    if (!/\.(js|mjs|cjs|ts)$/.test(f)) continue;
    for (const m of readFileSync(f, "latin1").matchAll(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) libHex.add(m[0].toLowerCase());
  }
}
const allowedHex = [];
for (const f of clientFiles.filter((p) => /\.(js|css|html|json)$/.test(p))) {
  const s = readFileSync(f, "latin1");
  for (const [re, what] of patterns) {
    if (what.startsWith("32-byte")) {
      for (const m of s.matchAll(new RegExp(re.source, "g"))) {
        if (libHex.has(m[0].toLowerCase())) allowedHex.push(m[0]);
        else failures.push(`${what} not from any dependency, in client file ${f}: ${m[0].slice(0, 12)}…`);
      }
      continue;
    }
    const m = s.match(re);
    if (m) failures.push(`${what} found in client file ${f}: ${m[0].slice(0, 20)}…`);
  }
}
console.log(`[bundle-check] ${new Set(allowedHex.map((h) => h.toLowerCase())).size} distinct 32-byte constants in client code, all published library constants`);

console.log(`[bundle-check] scanned ${scannedAll} build files for canaries, ${clientFiles.length} client files for secret patterns`);
if (failures.length) {
  console.error("[bundle-check] FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("[bundle-check] OK: no secret value or secret env name reaches the client bundle");
rmSync(DIST, { recursive: true, force: true });
