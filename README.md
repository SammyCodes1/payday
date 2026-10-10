# Payday · `SpendPolicy` (day 1) + web app (day 2)

Payday is an accounts-payable agent for small Lagos businesses and freelancers. An AI agent reads
invoices and decides **PAY_NOW / SCHEDULE / ASK / ESCALATE / REJECT**. It pays in USDC on **Arc**.

`SpendPolicy` limits what the agent can do, and the agent cannot talk its way past it. Each
business gets its own policy contract. That contract **holds the business's USDC**, and the only
way the agent can move money is `requestPayment`. Every limit is checked on-chain.

> Status: built and tested locally only. **Nothing has been deployed.** No keys exist in this repo.

---

## Files

| Path | What |
| --- | --- |
| `src/SpendPolicy.sol` | The contract (~480 lines incl. comments) |
| `test/Base.t.sol` | Shared fixture (accounts derived at runtime from Foundry's public test mnemonic) |
| `test/SpendPolicy.t.sol` | 70 unit tests: every rule, boundary + past-boundary for every limit |
| `test/Adversarial.t.sol` | 20 tests: reentrancy, blocklist, false-returning token, EIP-712 approvals |
| `test/SpendPolicy.fuzz.t.sol` | 10 property fuzz tests (10,000 runs each) |
| `test/SpendPolicy.invariant.t.sol` | Handler + 5 invariants (10,000 runs × depth 50 = 500,000 calls) |
| `test/mocks/MockUSDC.sol` | 6-decimal USDC mock with Circle-style blocklist; 18-decimal mock |
| `test/mocks/BadTokens.sol` | False-returning token; re-entrant malicious token |
| `script/DeploySpendPolicy.s.sol` | Deploy script for later use (not run) |
| `foundry.toml` | solc 0.8.30, `evm_version = "paris"`, fuzz/invariant 10k runs |

## Design

### Custody: the contract holds the funds
The owner funds the policy with a plain USDC `transfer` to its address. We considered the
alternative, where the business wallet `approve`s the policy and the policy pulls with
`transferFrom`. We rejected it because the money would stay in a wallet, and anything else that
wallet has approved, or whoever holds its key, could move it without going through the policy. When
the contract holds the funds:
* the only outflows are `requestPayment` (agent, capped), `approvePending` /
  `approvePendingWithSig` (owner, still subject to the ceiling), and `withdraw` (owner only);
* the agent's key never holds or is approved for the business's USDC. It is a Circle wallet that
  only pays its own gas.

### Roles
* **owner**: the human business owner, using a separate key. Changes every setting, approves or
  rejects pending payments, pauses, and withdraws. Ownership uses `Ownable2Step` (transfer, then
  accept). Ownership cannot be renounced, because that would strand the funds. It can never be
  given to the agent address or an allow-listed payee, and a pending owner who became an
  allow-listed payee cannot accept (choice for L-05: `acceptOwnership` reverts; the current owner
  must `removePayee` first. The payee entry is never silently removed).
* **agent**: the Circle-wallet key the AI uses. It can only call `requestPayment`. It cannot cancel,
  approve or change anything (agent cancel was removed after audit L-06, so it can no longer burn an
  id the owner has just signed). Tests call all 17 owner-only
  functions as the agent, and every call reverts. The agent cannot be the owner, the pending owner,
  or an allow-listed payee, because it could then pay itself. `setAgent` bumps `agentEpoch`; every
  Pending payment requested by an earlier agent key can no longer be approved (audit L-02), and a
  former agent key (`wasAgent`) can never be allow-listed.

### Limits (all owner-only setters emit events)
Amounts are raw 6-decimal token units (1 USDC = `1_000_000`).

| Limit | Rule | Exceeded → |
| --- | --- | --- |
| Payee allow-list | `setPayee(addr, label, category, cap)` / `removePayee`. Rejects zero, self, token, agent, any former agent, owner, pending owner. Removing or re-adding bumps `payeeEpoch[payee]` | **revert** |
| Invoice key (optional) | `invoiceKey != 0` already held by a Pending or Executed payment | **revert** `InvoiceAlreadyUsed` |
| Open pending | `openPending < maxOpenPending` (owner-set, default 20; 0 = no new Pending) | **revert** `TooManyOpenPending` (auto-pay within caps still works) |
| Category match | `category` passed by the agent must equal the payee's category | **revert** |
| Per-payment cap | `amount <= perPaymentCap` | Pending (`overLimits` bit 1) |
| Monthly cap | rolling-window total + amount `<= monthlyCap` | Pending (bit 2) |
| Category budget | rolling-window category total + amount `<= categoryBudget[cat]`. A budget of 0 means nothing in that category auto-pays | Pending (bit 4) |
| Per-payee cap (optional) | rolling-window payee total + amount `<= cap`. 0 = no cap | Pending (bit 8) |
| Global ceiling | lifetime `totalPaid + amount <= globalCeiling`. **Can only be lowered** | **revert**, even with owner approval |
| Pause | `pause()` / `unpause()` | **revert** (requests and approvals) |
| Pending TTL | 1–90 days (`setPendingTtl`). Each pending payment stores its own `expiresAt` | approval reverts after expiry |

**Rolling window, no edge double-spend.** We do not use calendar epochs, because with those an agent
could spend the cap at 23:59 on the last day and again at 00:00. Instead, spend is stored in 31
daily buckets (UTC days) in a ring buffer. A payment on day *D* is checked against everything paid
on days *D-30 … D*. Any span of 30×24h touches at most 31 consecutive days, so one check covers it.
That means **auto-paid spend in any 30-day span is ≤ `monthlyCap`**. This is proven by the
`testFuzz_rollingWindowNeverExceedsMonthlyCap` fuzz test and the
`invariant_windowCapHoldsExceptOwnerApproved` invariant. The window is slightly conservative: an
amount stops counting at the start of the 31st day after it was paid. The loop is fixed at 31
iterations, so it is bounded.

**Pending payments do NOT reserve budget.** A payment only goes Pending because it is already over
some limit, so the owner approving it is an explicit override. Reserving budget for requests that
may be rejected would block legitimate small payments. Budgets are consumed when money moves, and
that includes owner-approved payments. An approved payment can push the window above
`monthlyCap`, and auto-payments then stay Pending until it rolls off.

**Global ceiling: why only down.** This is the mainnet exposure cap: the most this deployment can
ever pay out. If it could be raised, a phished or socially-engineered owner session could remove the
backstop. To allow more, the owner deploys a fresh policy and moves funds over with `withdraw`.
Lowering it below `totalPaid` acts as a permanent kill switch for payments. A request that would
break the ceiling reverts outright rather than going Pending, because `totalPaid` only grows and the
ceiling only shrinks, so it could never be approved.

### Paying
`requestPayment(paymentId, payee, amount, category, reasonHash, invoiceKey)`, agent only:
1. Hard rules **revert** and leave no state: wrong caller, paused, `paymentId == 0`, id already
   used, `amount == 0`, invoiceKey already held, payee not allow-listed, category mismatch, over the
   global ceiling, insufficient balance, and (only when it would go Pending) the open-pending limit.
2. Within every cap: status is set to `Executed`, totals and buckets are updated,
   `PaymentExecuted` is emitted, and then `SafeERC20.safeTransfer` runs
   (checks-effects-interactions).
3. Over any soft cap: the payment is stored as `Pending` with `expiresAt`, and `PaymentPending` is
   emitted with a bitmask of the limits it exceeded.

`approvePending(id)` (owner) and `approvePendingWithSig(id, nonce, deadline, sig)` (anyone can
submit an owner signature, e.g. a relayer or sponsored tx) re-check: pause, pending status,
expiry, same `agentEpoch` as at request time (L-02), payee still allow-listed with the same
`payeeEpoch` (L-03) and the same category (charged to the payee's current category), global
ceiling, and balance. `rejectPending` (owner only) and `expirePending` (anyone, after expiry) close
a request; there is no agent cancel (L-06). Stale pendings can only be rejected or left to expire.
**A `paymentId` is burned forever once it is used**: Executed, Pending, Rejected and Expired all
block reuse (`Cancelled` stays in the enum for stable numbering but is unreachable). A request that
*reverted* never existed, so it does not consume the id.

**Invoice dedup (L-01).** `paymentId` is chosen off-chain, so on its own it does not stop one
invoice being paid twice under fresh ids. The optional `invoiceKey` closes that on chain: while a
payment holding a key is Pending or Executed, any other request with that key reverts
(`invoicePayment[key]` records the holder; reject/expiry release it). The web app always sets it to
`keccak256(tag, chainId, policy, payee, keccak256(normalizedInvoiceNumber))` (amount excluded, so
an altered-amount re-send is refused too). Limits: an agent that sends `invoiceKey = 0` or a
different key gets no dedup, so against a fully compromised agent key the bound is still the caps;
the key derivation lives in deterministic app code, not in model output.

### EIP-712 signed approval
Domain: `name="Payday SpendPolicy", version="1", chainId, verifyingContract` (OZ `EIP712`, which
recomputes the separator if the chain id changes). Type:
`ApprovePending(bytes32 paymentId,address payee,uint256 amount,bytes32 category,bytes32 reasonHash,uint64 expiresAt,uint256 ownerEpoch,uint256 nonce,uint256 deadline)`.
The contract exposes `approvalDigest(id, nonce, deadline)` so UIs can cross-check the hash.
* The signature binds every immutable field of the pending payment (payee, amount, category,
  reasonHash, expiresAt; I-05), so a tampered request fails.
* `ownerEpoch` increments on every ownership change, so signatures from any earlier tenure are dead,
  including after an A → B → A round-trip (L-04).
* Owners can be EOAs (ECDSA, malleable `s` rejected) or smart-contract wallets (ERC-1271, I-01). The
  check mirrors OZ `SignatureChecker.isValidSignatureNow`; it is inlined because OZ 5.4's
  `SignatureChecker` imports `Bytes.sol`, which uses `MCOPY` and cannot compile for `paris`.
* Nonces are unordered (`nonceUsed[nonce]`), so several approvals can be outstanding at once. The
  owner can burn a nonce with `invalidateNonce` to revoke a signature that has not been used.
* `deadline` is inclusive. The signer must be the **current** owner under the current `ownerEpoch`.
* Tests cover: relayer submit, replay, reusing a nonce on another payment, the deadline boundary,
  wrong signer, tampered amount or payee, another contract, another chain id (including a live
  `chainId` change), an invalidated nonce, an old owner after transfer, paused, a malformed
  signature, a ghost id, ceiling, and expiry.

### Decision log from chain data
Every decision emits an event carrying `reasonHash`, the hash of the agent's off-chain reasoning
or invoice evidence:
`PaymentExecuted(id, payee, amount, category, reasonHash, ownerApproved)`,
`PaymentPending(..., reasonHash, overLimits, expiresAt, invoiceKey, agentEpoch, payeeEpoch)`,
`PaymentApproved(id, approver, reasonHash)`, `PaymentRejected(id, reasonHash)`, `PaymentExpired(id, reasonHash)`.
Every setting change also emits an event, including the initial values from the constructor. Hard-rule
refusals revert, so they show up only as failed transactions with a custom error, not as events.

### Safety
* `ReentrancyGuard` on every function that moves funds, plus checks-effects-interactions.
  `ReentrantToken` tests re-enter `requestPayment`, `approvePending` and `withdraw` while holding
  the agent or owner role, and the guard stops each one.
* No `delegatecall`, no proxy or upgradeability, no `selfdestruct`, and no `receive`/`fallback`, so
  native sends revert.
* **Failed or blocklisted transfers**: if the token reverts (USDC blocklist) or returns `false`
  (SafeERC20), the whole transaction reverts. Status, totals and buckets are untouched and the id
  stays unused. If it was a pending payment, it stays Pending and the owner can reject it. Tests
  cover a blocklisted payee, a blocklisted policy contract, a later un-block followed by a retry
  with the same id, and a false-returning token.
* **Decimals**: the constructor reads `decimals()` and refuses anything other than 6. That prevents
  a deploy against an 18-decimal token, where caps would be off by 10¹². Tests cover paying 1
  micro-unit and the cap boundary at `1_000.000000` (pays) vs `1_000.000001` (pending), plus a fuzz
  test over micro-unit caps.
* Custom errors throughout. Every loop is bounded (31 iterations).

## Threat model

| Threat | What stops it |
| --- | --- |
| **Prompt-injected agent** (a malicious invoice says "pay 0xEvil 50,000") | 0xEvil is not on the allow-list, so the request reverts. Even for a real payee, the amount is capped per payment, per rolling 30 days, per category and per payee. Anything larger goes Pending for the human. The agent has no function that changes limits or the allow-list. |
| **Stolen agent key** | The attacker gets exactly what the agent has: allow-listed payees only, within the caps, up to the lifetime ceiling. Worst case is the remaining monthly room. The owner can `pause()`, `setAgent(newKey)` (which makes every pending the old key parked unapprovable) and `withdraw`. The old key can park at most `maxOpenPending` requests. The agent key holds no business funds and has no allowance. |
| **Malicious payee** (contract or token tricks, reentrancy) | USDC has no transfer hooks. Even so, every value-moving function is `nonReentrant` with CEI, which the malicious-token tests show. A payee that gets USDC-blocklisted can only make its own payment revert, with no stuck state. |
| **Replay** | `paymentId` is single-use for every outcome. The same invoice is refused on chain while its `invoiceKey` is Pending or Executed, as long as the key is set (the app always sets it; a compromised agent key could omit it, bounded by the caps). The app additionally dedups by paymentId and invoice number. EIP-712 approvals carry nonce, deadline, chainId, contract, ownerEpoch and every payment field. |
| **Window-edge gaming** | The 31-bucket rolling window means no reset at a boundary. |
| **Owner key compromise** | Out of scope for the policy: the owner can withdraw. Mitigations: keep the owner key in a hardware or Circle user-controlled wallet, keep the ceiling low, and keep balances small. |
| **Validator timestamp skew** | Arc timestamps are second-granular and non-decreasing. A skew of seconds can only move a payment between adjacent days, and the 31-day lookback absorbs that. |
| **USDC blocklists the policy itself** | Payments and withdrawals all revert, so funds are frozen by the issuer. Accepted risk, same as any USDC holder. |

## Arc facts (verified on official docs, 3 Oct 2026)

| Fact | Value | Source |
| --- | --- | --- |
| Arc Testnet chain ID | `5042002` | https://docs.arc.io/arc/references/connect-to-arc , https://docs.arc.io/arc/references/rpc-endpoints |
| Arc Testnet RPC | `https://rpc.testnet.arc.io` (also Blockdaemon / dRPC / QuickNode) | same |
| Arc Mainnet chain ID / RPC | `5042` / `https://rpc.mainnet.arc.io` | https://docs.arc.io/arc/references/connect-to-arc |
| USDC (ERC-20 interface), testnet **and** mainnet | `0x3600000000000000000000000000000000000000`, **6 decimals** | https://docs.arc.io/arc/references/contract-addresses |
| USDC is the native gas token | native balance uses **18 decimals**. Same underlying balance as the ERC-20 view (no wrapper). 1 ERC-20 unit = 10¹² native wei | https://docs.arc.io/arc/concepts/stablecoin-native-model , https://docs.arc.io/arc/references/evm-differences |
| ERC-20 `balanceOf` truncates below 1e-6 USDC | native dust may exist that the ERC-20 view shows as 0 | same |
| Blocklist enforced at runtime | a value transfer to or from a blocklisted address reverts and still costs gas. Testnet seeds `0x7099…79C8` (test mnemonic index 1) as blocklisted | https://docs.arc.io/arc/references/contract-addresses , https://docs.arc.io/integrate/infrastructure/compliance |
| EVM baseline | Osaka. `PREVRANDAO` = 0. Base fee min **20 gwei** (lower `maxFeePerGas` is silently dropped). Timestamps non-decreasing, second granularity. Value sends to `address(0)` revert | https://docs.arc.io/arc/references/evm-differences |
| Arc Foundry (`arc-forge`, `arc-anvil`) | Arc-aware fork. Windows supported via WSL only. Plain `anvil` cannot reproduce Arc's blocklist or precompiles | https://docs.arc.io/arc/tutorials/install-arc-foundry |
| Circle sample conventions | `circlefin/arc-escrow` uses `pragma ^0.8.24`, OZ `IERC20` + `EIP712`, custom errors. `circlefin/arc-fintech` uses the same USDC address for `ARC-TESTNET` | https://github.com/circlefin/arc-escrow , https://github.com/circlefin/arc-fintech |

How this shaped the code:
* We use **only the ERC-20 interface** (`0x3600…`, 6 decimals) for balances and transfers, as the
  docs recommend. The contract has no `payable` entry points. If native USDC is ever forced in
  (e.g. via `SELFDESTRUCT`), it shows up in the ERC-20 balance and the owner can withdraw it, except
  for sub-micro dust.
* The constructor enforces `decimals() == 6`.
* The blocklist revert path is tested with a mock. The mock reuses the same address Arc Testnet
  seeds as blocklisted.

## Build & test

```bash
forge build
forge fmt --check
forge test            # 10k fuzz runs per test, invariants 10k runs × depth 50 (~3 min)
```

Results after the audit fixes (10 Oct 2026): **126 tests passed, 0 failed** (69 unit + 20 adversarial
+ 26 audit regressions in `test/audit/AuditRegression.t.sol` + 10 fuzz + 1 invariant suite with 7
invariants, 500,000 calls). The invariant handler predicts every call's outcome (success or the exact
revert selector); any mismatch, or a run with zero successes, fails (`afterInvariant`). It drives
payee/agent/ownership changes, signed approvals, cap changes and window-edge warps (audit T-01..T-03).
Mutation testing: 24 mutants (the auditor's 11 plus 13 targeting the fixes), all killed; 19 of them
also by the invariants alone.

Gas, measured locally: `requestPayment` averages ~224k gas, ~490k worst case on a first payment
with cold storage. At Arc's 20 gwei minimum that is about 0.01 USDC per payment.

Slither 0.11.6 (`slither . --filter-paths "lib/|test/|script/"`) reports 10 findings in 6 detector
classes. All are expected and accepted (new since the fixes: `unused-return` on `ECDSA.tryRecover`'s
third value, which is folded into the error check; `dead-code` on `_transferOwnership`, which is an
override Ownable calls; `low-level-calls` for the ERC-1271 `staticcall`, as in OZ SignatureChecker):
* `weak-prng`: `today % 31` is the ring-buffer index, not randomness.
* `incorrect-equality`: `b.day == today` is an intentional same-day bucket check.
* `timestamp` (5): day-granular expiry, deadline and window logic. The skew analysis is above.

## TODOs / open questions

* **TODO (EVM target)**: the official docs say the Osaka baseline. A community note
  (circlefin/arc-node PR #151) said PUSH0 was unsupported and recommended `paris`. We compile for
  `paris`, which is safe on both. Confirm with a testnet dry-run, then optionally switch to
  `prague`/`osaka` to save gas.
* **TODO (Arc Foundry)**: run the suite under `arc-forge` or against `arc-anvil --network arc`, and
  run a testnet smoke test against the real blocklist address, before any mainnet use.
* **TODO (explorer verify URL)**: the docs show both `testnet.arcscan.app` and
  `explorer.testnet.arc.io`. The Blockscout API path below comes from the community PR. Verify
  before use.
* **TODO (Circle Wallets / Paymaster wiring)**: how the agent's developer-controlled wallet submits
  `requestPayment` (Contract Execution API), and whether the owner approval goes through Paymaster
  sponsorship or `approvePendingWithSig` via a relayer. This is day 2.
* **TODO (reasonHash format)**: fix the canonical off-chain encoding, e.g.
  `keccak256(JSON-canonical{decision, invoiceHash, modelVersion, rationale})`, and the
  `paymentId` derivation (`keccak256(invoiceNo, vendorTaxId, issueDate, payee, amount)`), so the
  log can be re-verified.
* **Question**: is the 31-day lookback acceptable UX? Freed budget returns day by day, not all at
  once.
* **Question**: should owner `withdraw` be limited to a fixed treasury address? Currently it goes
  to any address the owner chooses.
* **Question**: should hard-rule refusals also be logged? They currently revert with no event. A
  non-reverting `PaymentRefused` would let the agent spam storage, which is why we avoided it.

## Deploy (later; do NOT run yet)

Windows PowerShell. Arc Foundry officially supports Windows only through WSL. Standard Foundry for
Windows also works for a plain deployment, but you must pass a max fee of at least 20 gwei.
The keystore prompt asks for the deployer key interactively and stores it encrypted. Never paste a
key into a file or an env var.

```powershell
# 0) One-time: create an encrypted keystore for the DEPLOYER (any funded testnet address).
#    Get testnet USDC for gas at https://faucet.circle.com (Arc Testnet).
cast wallet import payday-deployer --interactive
```

```powershell
# 1) Build + test locally first
Set-Location C:\path\to\payday
forge build
forge test
```

```powershell
# 2) Parameters (raw 6-decimal units: 1 USDC = 1000000)
$env:PAYDAY_OWNER            = "0xYourOwnerAddress"        # TODO: business owner's wallet
$env:PAYDAY_AGENT            = "0xYourCircleAgentWallet"   # TODO: Circle dev-controlled wallet
$env:PAYDAY_PER_PAYMENT_CAP  = "100000000"                 # 100 USDC
$env:PAYDAY_MONTHLY_CAP      = "500000000"                 # 500 USDC
$env:PAYDAY_GLOBAL_CEILING   = "1000000000"                # 1,000 USDC lifetime (testnet demo)
$env:PAYDAY_PENDING_TTL      = "604800"                    # 7 days
```

```powershell
# 3) Deploy to Arc Testnet (chain 5042002). The script refuses non-Arc chains.
forge script script/DeploySpendPolicy.s.sol:DeploySpendPolicy `
  --rpc-url https://rpc.testnet.arc.io `
  --account payday-deployer `
  --with-gas-price 25gwei --priority-gas-price 1gwei `
  --broadcast
$env:POLICY = "0xDeployedPolicyAddress"   # copy from the output
```

```powershell
# 4) Owner configures categories + payees (run with the OWNER's keystore)
$OPS = cast format-bytes32-string "OPS"
cast send $env:POLICY "setCategoryBudget(bytes32,uint256)" $OPS 300000000 `
  --rpc-url https://rpc.testnet.arc.io --account payday-owner --gas-price 25gwei
cast send $env:POLICY "setPayee(address,string,bytes32,uint256)" 0xVendorAddress "Landlord" $OPS 0 `
  --rpc-url https://rpc.testnet.arc.io --account payday-owner --gas-price 25gwei
```

```powershell
# 5) Fund the policy with USDC (ERC-20 interface, 6 decimals)
cast send 0x3600000000000000000000000000000000000000 "transfer(address,uint256)" $env:POLICY 50000000 `
  --rpc-url https://rpc.testnet.arc.io --account payday-owner --gas-price 25gwei
cast call $env:POLICY "spentInWindow()(uint256)" --rpc-url https://rpc.testnet.arc.io
```

```powershell
# 6) (Optional) Verify on the explorer - TODO confirm URL, see TODOs
forge verify-contract $env:POLICY src/SpendPolicy.sol:SpendPolicy `
  --verifier blockscout --verifier-url "https://testnet.arcscan.app/api/" `
  --chain 5042002 --compiler-version 0.8.30 --evm-version paris --guess-constructor-args `
  --rpc-url https://rpc.testnet.arc.io --watch
```

Mainnet (chain `5042`, RPC `https://rpc.mainnet.arc.io`) needs `$env:I_UNDERSTAND_THIS_IS_MAINNET = "true"`
and a deliberately small `PAYDAY_GLOBAL_CEILING`. Only do this after the TODOs above are closed.

---

# Day 2 · Payday web app (`web/`)

Next.js 16 (App Router, TypeScript) owner console plus a server-side agent. There is no Telegram code anywhere.
**`src/SpendPolicy.sol` and its tests were not changed on day 2** (sha256 `4d267fb3…e857c4`), because an audit of that file is in progress.

## Architecture

```
browser (owner wallet, wagmi/viem)            server (Next route handlers, Node runtime)                chain
──────────────────────────────────            ───────────────────────────────────────────              ─────
SIWE sign-in ───────────────────────────────▶ /api/auth/*  (nonce in DB, owner-only, HMAC cookie)
upload PDF/photo ───────────────────────────▶ /api/invoices
                                               1. upload limits: size, MIME + magic bytes, rate limit
                                               2. extract: AI SDK generateText + Output.object (zod),
                                                  NO tools, untrusted-data prompt, re-validated by zod
                                               3. injection scan (fields + raw PDF text)
                                               4. match payee by OWNER-SET identifier/label against the
                                                  on-chain allow-list (address only ever from chain) ◀── getPayee / PayeeSet events
                                               5. deterministic engine: PAY_NOW|SCHEDULE|ASK|ESCALATE|REJECT ◀── caps, budget, balance, getPayment
                                               6. reasonHash = keccak(canonical JSON), stored in SQLite
                                               7. LLM explanation (advisory only, never parsed)
                                               8. if action=submit: simulate, then executor.requestPayment ──▶ SpendPolicy.requestPayment
                                                  executor = Circle dev-controlled wallet | local anvil        (Executed or Pending)
approve: writeContract approvePending ─────────────────────────────────────────────────────────────────────▶ approvePending
   or   signTypedData(ApprovePending) ─────▶ /api/approvals/relay (verify owner sig) ──▶ agent relays ───────▶ approvePendingWithSig
reject: writeContract rejectPending ───────────────────────────────────────────────────────────────────────▶ rejectPending
payees, caps, budgets, TTL, pause ─────────────────────────────────────────────────────────────────────────▶ owner-only setters
decision log ◀───────────────────────────── /api/log  = policy events ⨝ reason_docs (verified vs reasonHash) ◀── eth_getLogs
public stats ◀───────────────────────────── /api/stats, /stats  = PaymentExecuted events only ◀── eth_getLogs
cron ──────────────────────────────────────▶ /api/cron/due (Bearer CRON_SECRET): re-evaluate due SCHEDULED
```

The agent can only call `requestPayment` and relay owner-signed approvals. Every limit is enforced by the contract.
The app's own checks are stricter, and they only ever add friction; they cannot move money beyond what the contract allows.

## Files (web/)

| Path | What |
|---|---|
| `src/app/page.tsx` | Inbox: upload + invoice list |
| `src/app/invoices/[id]/page.tsx` | Decision, checks, highlighted injection flags, extracted fields, owner actions |
| `src/app/approvals/page.tsx` | Pending approvals (badge in nav): approve by signature / by tx, reject |
| `src/app/settings/page.tsx` | Policy overview, pause/unpause, caps, budgets, TTL, ceiling, setPayee/removePayee, app-side terms |
| `src/app/log/page.tsx` | Decision log rebuilt from events, "verified" badge per reason doc |
| `src/app/stats/page.tsx` | PUBLIC stats (PaymentExecuted only) with explorer links |
| `src/app/api/**/route.ts` | auth (nonce, verify, me, logout), invoices (+[id], resolve), approvals (+relay), payees, policy, log, stats, cron/due |
| `src/proxy.ts` | Next 16 proxy: rejects `/api/*` without a valid session, except the public routes |
| `src/components/ui.tsx`, `Header.tsx`, `Brand.tsx`, `Footer.tsx` | Design system (see "UI style") |
| `src/lib/invoice/{schema,extract,mock-model,pdf-text,upload}.ts` | zod schema, AI SDK extraction, offline mock model, PDF text layer, upload limits |
| `src/lib/llm/provider.ts` | Provider chosen by `PAYDAY_LLM_PROVIDER` (mock / openai / anthropic / google) |
| `src/lib/injection.ts` | Injection rules |
| `src/lib/decision/{types,match,engine}.ts` | Payee matching + pure deterministic engine |
| `src/lib/{ids,canonical-json,money}.ts` | paymentId / reasonHash / exact money |
| `src/lib/executor/{circle,local,index,types}.ts` | Circle Developer-Controlled Wallets executor, local anvil executor |
| `src/lib/{pipeline,registry,events,chain,receipts,explain,db,config,rate-limit}.ts` | Orchestration, registry, event log, reads, SQLite, env, rate limits |
| `src/lib/auth/{session,siwe,guard}.ts` | HMAC session cookie, SIWE, route guards |
| `scripts/check-bundle.mjs` | Secret bundle check |
| `scripts/make-fixtures.mjs` | Generates `fixtures/invoices/*` |
| `scripts/demo-local.mjs` | Local anvil demo (deploy + seed + `.env.local`) |
| `scripts/run-scheduler.mjs` | Calls `/api/cron/due` |
| `scripts/export-abi.mjs` | `../out` → `src/lib/abi.ts` |
| `test/unit/*` | 129 unit tests |
| `test/e2e/flow.test.ts` | 23-step E2E against local anvil with the real SpendPolicy |
| `.env.example` | Env var NAMES only |

## Hash encodings (fixed, v1)

**paymentId**
```
ref       = NFKC(invoiceNumber) → UPPERCASE → keep [A-Z0-9] only        ("inv/2026-0042" → "INV20260042")
paymentId = keccak256(abi.encode(
              bytes32 keccak256("PAYDAY_PAYMENT_ID_V1"),
              uint256 chainId,
              address policy,
              address payee,        // from the on-chain allow-list, never from the invoice
              uint256 amount,       // 6-decimal units
              bytes32 keccak256(utf8(ref))))
```
Due and issue dates are left out on purpose, so a re-sent invoice with a new date still collides. A different amount gives a different id; the engine catches that case by invoice number (INVOICE_NUMBER_REUSED → ESCALATE), and the contract refuses it via `invoiceKey`.

**invoiceKey** (on-chain dedup, `src/lib/ids.ts computeInvoiceKey`)
```
invoiceKey = keccak256(abi.encode(
               bytes32 keccak256("PAYDAY_INVOICE_KEY_V1"),
               uint256 chainId,
               address policy,
               address payee,
               bytes32 keccak256(utf8(ref))))      // amount deliberately excluded
```

**reasonHash** = `keccak256(utf8(canonicalJson(reasonDoc)))`.
- canonicalJson: object keys sorted by UTF-16 code unit, no whitespace, strings escaped as in `JSON.stringify`, only safe integers allowed (no floats, bigint, NaN or undefined; amounts are decimal strings).
- `reasonDoc = {v:1, engine:"payday-decision-v1", invoiceId, evaluatedAt, paymentId, decision, reasons:[{code,outcome,detail}], invoice:{fileSha256, invoiceNumber, payeeName, payeeIdentifier, amount, currency, dueDate}, payee:{address,label,category}|null, injectionRules:[…], ownerConfirmation:{by,codes}|null}`.
- The exact canonical string is stored in `reason_docs`. The log marks an event **verified** only when `keccak256(stored string) == event.reasonHash`.

## Decision engine (deterministic, `src/lib/decision/engine.ts`)

Every finding becomes a reason `{code, outcome, detail}`. The decision is the most severe outcome, ordered PAY_NOW < SCHEDULE < ASK < ESCALATE < REJECT.

| Check | Outcome |
|---|---|
| Extraction failed zod | ASK |
| Injection phrase (any rule except bare address) | ESCALATE |
| Unknown / ambiguous payee; not allow-listed on chain; name mismatch | ESCALATE |
| New or changed identifier, bank details, or any wallet address that is not the on-chain one | ESCALATE (PAYEE_DETAILS_CHANGED) |
| paymentId already used on chain or held in the app | REJECT |
| Same payee + invoice no. + amount already paid / in flight | REJECT; amount differs → ESCALATE; previous was escalated → ASK |
| Same payee + amount within 20 days | ASK (owner can confirm) |
| Fixed / unit rate / milestone mismatch; milestone already paid | ESCALATE |
| Line items don't add up | ASK |
| No agreed terms on file | ASK (owner can confirm) |
| Over lifetime ceiling | REJECT (the contract would revert) |
| Paused / insufficient balance | ASK, not submitted |
| Runway: balance − amount < committed bills (scheduled + awaiting + pending) + buffer | ASK (owner can confirm) |
| Over per-payment / monthly / category / payee cap | ASK, **submitted** so the contract parks it as Pending for on-chain approval |
| Pay-on date (due − `PAYDAY_SCHEDULE_LEAD_DAYS`) in the future | SCHEDULE (SQLite; re-evaluated by `/api/cron/due`) |
| Unsupported currency (not USD/USDC) | ASK |

In-app owner confirmation can only downgrade NO_AGREED_TERMS, LINE_ITEMS_MISMATCH, POSSIBLE_DUPLICATE and RUNWAY_SHORTFALL. It can never clear an ESCALATE or REJECT reason, or a contract cap.

## Database

SQLite through Node's built-in `node:sqlite` (Node ≥ 22.13), which needs no native build. File: `PAYDAY_DB_PATH`, default `./data/payday.sqlite`.
- Tables: `invoices`, `reason_docs`, `payees` (owner-set identifiers, bank details and terms), `auth_nonces`.
- Uploaded files are not stored; only their sha256 is kept.
- Use a single instance. Postgres would be the move for several instances (see open questions).

## Environment variables (names only; see `web/.env.example`)

| Group | Names |
|---|---|
| Chain / policy | `PAYDAY_CHAIN`, `PAYDAY_RPC_URL`, `PAYDAY_POLICY_ADDRESS`, `PAYDAY_POLICY_DEPLOY_BLOCK`, `PAYDAY_STATS_POLICIES`, `PAYDAY_LOG_CHUNK` |
| Agent | `PAYDAY_EXECUTOR` (`circle`/`local`/`none`), `PAYDAY_LOCAL_AGENT_INDEX`, **`CIRCLE_API_KEY`**, **`CIRCLE_ENTITY_SECRET`**, `CIRCLE_AGENT_WALLET_ID`, `CIRCLE_AGENT_WALLET_ADDRESS` |
| LLM | `PAYDAY_LLM_PROVIDER`, `PAYDAY_LLM_MODEL`, **`OPENAI_API_KEY`** / **`ANTHROPIC_API_KEY`** / **`GOOGLE_GENERATIVE_AI_API_KEY`** (only the one you use) |
| App | **`SESSION_SECRET`**, **`CRON_SECRET`**, `PAYDAY_APP_ORIGIN`, `PAYDAY_DB_PATH`, `PAYDAY_MAX_UPLOAD_BYTES`, `PAYDAY_SCHEDULE_LEAD_DAYS`, `PAYDAY_RUNWAY_BUFFER_USDC` |
| Browser (public) | `NEXT_PUBLIC_CHAIN`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL` |

Bold names are secrets. They are read only in `server-only` modules, and the bundle check proves they never reach the browser.

## Circle + Arc integration facts (checked 3–4 Oct 2026)

- **Contract execution:** `POST /v1/w3s/developer/transactions/contractExecution`. SDK call `createContractExecutionTransaction({idempotencyKey, walletId, contractAddress, abiFunctionSignature, abiParameters, fee:{type:"level",config:{feeLevel}}})`, then poll `getTransaction({id})` until COMPLETE/CONFIRMED (FAILED/DENIED/CANCELLED are errors). <https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution>, <https://developers.circle.com/contracts/scp-interact-smart-contract>
- **Entity secret:** 32 bytes, registered once. Each request carries a fresh single-use ciphertext, and the Node SDK (`@circle-fin/developer-controlled-wallets`, `initiateDeveloperControlledWalletsClient({apiKey, entitySecret})`) does this for you. Keep the recovery file offline. <https://developers.circle.com/wallets/dev-controlled/entity-secret-management>
- **Wallets:** create a wallet set, then `createWallets({blockchains:["ARC-TESTNET"], count:1, walletSetId, accountType:"SCA"})`. <https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet>, <https://developers.circle.com/wallets/supported-blockchains>
- **Gas Station (Circle's paymaster):** supports Arc Testnet for developer-controlled wallets. EVM sponsorship needs an **SCA** wallet, and testnet comes with a default sponsorship policy. <https://developers.circle.com/wallets/gas-station>, <https://developers.circle.com/wallets/gas-station/send-a-gasless-transaction>
- **Reference code (circlefin/arc-fintech):** `lib/circle/developer-controlled-wallets-client.ts` (client init from `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET`) and `lib/circle/gateway-sdk.ts` (`createContractExecutionTransaction` + `getTransaction` polling). <https://github.com/circlefin/arc-fintech>
- **Arc Testnet:** chain id 5042002, RPC `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io` (the official docs list this; viem's built-in `arcTestnet` still says `testnet.arcscan.app`, so the app default is the docs value). USDC ERC-20 interface `0x3600000000000000000000000000000000000000` (6 decimals); native gas is USDC (18 decimals). <https://docs.arc.io/arc/references/connect-to-arc>, <https://docs.arc.io/arc/references/contract-addresses>
- Payday uses feeLevel `MEDIUM` and an idempotency key derived from paymentId (a v4-format UUID), so a retry can never create a second transaction. Each paymentId is also single-use on chain.

## Security

- **Auth:** SIWE (EIP-4361).
  - Nonces are single-use and expire after 10 minutes.
  - Only the current on-chain `owner()` can sign in, and every request re-checks this (15 s cache).
  - The session is an HMAC-SHA256 cookie: HttpOnly, SameSite=Strict, Secure on https, 8 h.
  - `proxy.ts` gates `/api/*`, and every owner route also calls `requireOwner`.
  - Writes also need a same-origin `Origin` header.
- **Public routes:** `/api/stats`, `/stats`, `/api/auth/nonce|verify|logout`. `/api/cron/due` needs `Bearer CRON_SECRET` (constant-time compare) or an owner session.
- **Uploads:** at most `PAYDAY_MAX_UPLOAD_BYTES` (5 MB); PDF/PNG/JPEG/WebP only; magic bytes must match the declared type → 400/413/415. Files are not persisted.
- **Rate limits** (per IP, fixed 1-minute window, in-memory): auth 20, upload 10, write 60, read 240, public 60.
- **Secrets** are server-only. `npm run check:bundle` builds with canary secret values and fails on:
  - any canary anywhere in the build output;
  - any secret env name, `CIRCLE_*`, PEM, dev mnemonic or Circle SDK in client chunks;
  - any 32-byte hex in client chunks that isn't a published library constant.
  A planted `"SESSION_SECRET"` in a client component made it fail as expected.
- **Gitleaks:** `gitleaks dir . --config .gitleaks.toml` → no leaks. The config only skips vendored and build dirs.
- **Local mode** uses Foundry's public test mnemonic. The local executor refuses any chain id other than 31337.

## UI style

The visual language follows the Ajo Circle frontend: layout, spacing, typography pairing, card, button and nav patterns, radius, elevation and motion. None of its colours, branding, names, copy or logic were reused.
- **Fonts:** self-hosted Fraunces (display/numerals), Inter Tight (UI) and JetBrains Mono (eyebrows/addresses), via @fontsource. No network fetch at build.
- **Palette:** "ledger" design tokens in `web/src/app/globals.css` (Tailwind v4 `@theme`).
  - Deep teal primary `#0e5a52` (8.1:1 with white).
  - Saffron accent `#e3a248` (ink text on it 7.6:1).
  - Mist page `#f2f5f1`.
  - Status text-on-wash contrast:
    - PAY_NOW `#17603a`/`#dcf0e2` 6.4:1
    - SCHEDULE `#1e4b8f`/`#e0e9f8` 7.0:1
    - ASK `#6f4a00`/`#f8ebc8` 6.7:1
    - ESCALATE `#9a3a0b`/`#fbe2d2` 5.7:1
    - REJECT `#9b2226`/`#f8dcdc` 6.1:1
  - All text pairs are WCAG AA or better.
- Motion is transform/opacity only, and `prefers-reduced-motion` turns it off.

## Tests & gates (results in `gates-web/`)

```
cd web
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm test               # 129 unit tests
npm run test:e2e       # 23 E2E steps on a throwaway anvil with the real SpendPolicy
npm run build
npm run check:bundle
```

The E2E test:
- **Setup:** spawns anvil and deploys MockUSDC + SpendPolicy from `../out`, signs in with SIWE through the real route handlers, and stores payee terms.
- **Upload cases:** checks 401/403/415/413/429 responses, then uploads all fixtures:
  - normal → **Executed**
  - injection → ESCALATE, attacker balance 0
  - changed bank → ESCALATE
  - duplicate → REJECT
  - over-cap → **Pending**
  - wrong rate → ESCALATE
  - future → SCHEDULE
  - large → Pending
  - unknown → ESCALATE
  - photo → no payment
- **Approvals:**
  - a forged EIP-712 approval is refused;
  - the owner's EIP-712 approval is relayed by the agent → paid;
  - the owner rejects the large order with a direct tx;
  - cron runs on the pay-on date → scheduled bill paid.
- **Log and stats:** every reason doc in the log verifies, and stats = 3 tx / 2,400 USDC / 1 business / 3 payees.

## PowerShell steps for later (NOT run; nothing here deploys or sends anything)

```powershell
# --- 0) Prereqs (once): Node 22.13+ and Foundry
node --version            # must be >= v22.13
cd $HOME\payday\web
npm ci

# --- 1) Local demo against anvil (safe: local chain, public test mnemonic)
#     Terminal A:
npm run demo:local        # starts anvil, deploys MockUSDC + SpendPolicy, writes .env.local
#     Terminal B:
npm run dev               # http://localhost:3000
#     In your browser wallet add network "Anvil" (RPC http://127.0.0.1:8545, chain 31337)
#     and import anvil account #0 to sign in as the owner. Upload files from fixtures\invoices.

# --- 2) All checks
npm run typecheck; npm run lint; npm test; npm run test:e2e; npm run build; npm run check:bundle

# --- 3) Arc Testnet config (after the policy is deployed per the day-1 steps and you have Circle creds)
#     Put values in web\.env.local (never commit it). Generate app secrets locally, e.g.:
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes); -join ($bytes | ForEach-Object { $_.ToString("x2") })
#     -> use one output for SESSION_SECRET and another for CRON_SECRET.
#     Required names: PAYDAY_CHAIN=arcTestnet, PAYDAY_RPC_URL, PAYDAY_POLICY_ADDRESS, PAYDAY_POLICY_DEPLOY_BLOCK,
#     PAYDAY_EXECUTOR=circle, CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_AGENT_WALLET_ID, CIRCLE_AGENT_WALLET_ADDRESS,
#     PAYDAY_LLM_PROVIDER, PAYDAY_LLM_MODEL, <provider>_API_KEY, SESSION_SECRET, CRON_SECRET, PAYDAY_APP_ORIGIN,
#     NEXT_PUBLIC_CHAIN=arcTestnet, NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_EXPLORER_URL

# --- 4) Point the policy's agent at the Circle SCA wallet (OWNER keystore; this IS a transaction - only when ready)
# cast send $env:POLICY "setAgent(address)" $env:CIRCLE_AGENT_WALLET_ADDRESS --rpc-url https://rpc.testnet.arc.io --account payday-owner

# --- 5) Run + schedule the due-date job (hourly)
npm run build; npm start
# $env:PAYDAY_APP_ORIGIN="http://localhost:3000"; $env:CRON_SECRET="<from .env.local>"; npm run scheduler
```

## Circle console steps for Sammy (do these yourself; never paste the values into chat)

1. In the Circle Developer Console (<https://console.circle.com>), create a **testnet API key** → `CIRCLE_API_KEY`.
2. Generate a 32-byte **entity secret**, then register it (console or SDK `registerEntitySecretCiphertext`). Store the **recovery file** offline → `CIRCLE_ENTITY_SECRET`.
3. Create a **wallet set**, then one **SCA** wallet on **ARC-TESTNET**. Copy its id → `CIRCLE_AGENT_WALLET_ID` and its address → `CIRCLE_AGENT_WALLET_ADDRESS`.
4. Check that **Gas Station** shows the default testnet policy for Arc Testnet, so the SCA wallet's calls are sponsored.
5. As owner, call `setAgent(<SCA address>)` on your SpendPolicy (step 4 above).
6. Choose an LLM provider and model with PDF/image input. Create that provider's API key → `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`, and set `PAYDAY_LLM_PROVIDER` and `PAYDAY_LLM_MODEL`.

## Day-2 open questions

- Single business per deployment (one policy, one owner) vs multi-tenant. Stats already support many policies (`PAYDAY_STATS_POLICIES`).
- Rate limits and the owner cache are in-memory per process. Several instances would need Redis, and Postgres instead of SQLite.
- Which LLM and model to use for extraction. The mock is used offline; real models are configured, never hard-coded.
- With a Circle SCA wallet, `msg.sender` at SpendPolicy is the SCA address, so `agent` must be set to that address. Testnet confirmation is still to come.
- Explorer: the docs say `explorer.testnet.arc.io` but viem says `testnet.arcscan.app`. The app defaults to the docs value; set `NEXT_PUBLIC_EXPLORER_URL` to override.
- Arc runtime differences that matter for the Circle executor (from the docs' EVM-differences notes):
  - blocklist reverts "consume gas without a receipt", so a submit could poll forever. The executor caps polling, and the app marks FAILED;
  - the mempool has a 20 gwei `maxFeePerGas` floor;
  - testnet mnemonic index 1 (`0x7099…79C8`) is deliberately blocklisted, so never use it as a payee or agent.
- Arc publishes its own Foundry fork (arc-forge/arc-anvil). Tests here use stock anvil; consider re-running the E2E on arc-anvil.
- An over-cap invoice that is also due later is submitted now, so the owner sees it in one place. Approving early pays early. Should it be held until the pay-on date instead?
- Contract observations after the audit fixes:
  - the agent can create at most `maxOpenPending` Pending entries and cannot cancel any;
  - hard-rule reverts leave no event, so the app-side log is the only trace of those refusals;
  - approval overrides the *current* soft caps (I-02, by design); the approvals page shows the request-time limits bitmask.
  - Pending entries don't reserve budget, so several approvals can exceed a cap. That is by design, since the owner overrides.
