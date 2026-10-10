// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title  SpendPolicy - the on-chain spending boundary for one Payday business.
/// @notice The contract HOLDS the business's USDC. The AI agent's key can only ask it to pay
///         allow-listed payees through `requestPayment`; every limit is enforced here, so a
///         prompt-injected or stolen agent cannot talk its way past them.
/// @dev    Amounts are raw token units. On Arc the USDC ERC-20 interface has 6 decimals
///         (1 USDC = 1_000_000); the constructor refuses any token that does not report 6.
///         No delegatecall, no proxy/upgradeability, no selfdestruct, no native-value entry points.
contract SpendPolicy is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    /// @notice Decimals the token must report (Arc USDC ERC-20 interface = 6).
    uint8 public constant TOKEN_DECIMALS = 6;
    /// @notice Rolling window length used for monthly / category / payee caps.
    uint256 public constant WINDOW_DAYS = 30;
    /// @dev One bucket per UTC day. A payment on day D is checked against days D-30..D (31 buckets),
    ///      so ANY span of 30 x 24h is covered by a single check -> no window-edge double spend.
    uint256 internal constant BUCKETS = WINDOW_DAYS + 1;
    uint256 public constant MIN_PENDING_TTL = 1 days;
    uint256 public constant MAX_PENDING_TTL = 90 days;
    /// @notice Default limit on simultaneously open Pending payments (L-06). Owner-adjustable.
    uint256 public constant DEFAULT_MAX_OPEN_PENDING = 20;

    /// @notice Bit flags explaining why a payment went to Pending (emitted in PaymentPending).
    uint8 public constant OVER_PER_PAYMENT_CAP = 1;
    uint8 public constant OVER_MONTHLY_CAP = 2;
    uint8 public constant OVER_CATEGORY_BUDGET = 4;
    uint8 public constant OVER_PAYEE_CAP = 8;

    /// @notice EIP-712 type for an owner approval that a relayer / Paymaster-sponsored tx can submit.
    ///         Binds every immutable field of the pending payment (I-05) and the current ownerEpoch (L-04).
    bytes32 public constant APPROVE_TYPEHASH = keccak256(
        "ApprovePending(bytes32 paymentId,address payee,uint256 amount,bytes32 category,bytes32 reasonHash,uint64 expiresAt,uint256 ownerEpoch,uint256 nonce,uint256 deadline)"
    );

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Pending,
        Executed,
        Rejected,
        Cancelled, // reserved: no longer reachable (agent cancel removed, L-06); kept so numbering is stable
        Expired
    }

    struct Payee {
        bool allowed;
        bytes32 category; // every payee belongs to exactly one budget category
        uint256 cap; // optional rolling-30-day cap for this payee; 0 = no per-payee cap
        string label;
    }

    struct Payment {
        address payee;
        Status status;
        uint64 expiresAt; // only meaningful while Pending
        uint256 amount;
        bytes32 category;
        bytes32 reasonHash; // hash of the agent's off-chain reasoning / invoice evidence
        bytes32 invoiceKey; // optional invoice dedup key (L-01); 0 = none
        uint32 agentEpoch; // agentEpoch at request time (L-02)
        uint32 payeeEpoch; // payeeEpoch[payee] at request time (L-03)
    }

    /// @dev Spend recorded on one UTC day. Packed into one storage slot.
    struct Bucket {
        uint64 day;
        uint192 amount;
    }

    // ------------------------------------------------------------------ storage

    IERC20 public immutable token;
    address public agent;

    uint256 public perPaymentCap;
    uint256 public monthlyCap;
    uint256 public globalCeiling; // lifetime outflow cap; can only be lowered
    uint256 public totalPaid; // lifetime outflow to payees
    uint256 public pendingTtl;
    uint256 public maxOpenPending; // L-06
    uint256 public openPending; // L-06: number of payments currently in status Pending
    uint32 public agentEpoch; // L-02: incremented by every setAgent
    uint32 public ownerEpoch; // L-04: incremented on every ownership change (incl. the constructor's)

    mapping(address => Payee) internal _payees;
    mapping(bytes32 => uint256) public categoryBudget; // per rolling window; 0 = nothing auto-pays
    mapping(bytes32 => Payment) internal _payments;
    mapping(uint256 => bool) public nonceUsed; // EIP-712 approval nonces (unordered)
    mapping(address => uint32) public payeeEpoch; // L-03: incremented on removal and on (re-)add
    mapping(address => bool) public wasAgent; // L-05: former agent keys can never be allow-listed
    /// @notice L-01: invoiceKey -> paymentId holding it (Pending or Executed). Released on reject/expire.
    mapping(bytes32 => bytes32) public invoicePayment;

    Bucket[BUCKETS] internal _totalWindow;
    mapping(bytes32 => Bucket[BUCKETS]) internal _categoryWindow;
    mapping(address => Bucket[BUCKETS]) internal _payeeWindow;

    // ------------------------------------------------------------------ events

    event AgentChanged(address indexed oldAgent, address indexed newAgent);
    event PayeeSet(address indexed payee, string label, bytes32 indexed category, uint256 cap);
    event PayeeRemoved(address indexed payee);
    event PerPaymentCapSet(uint256 oldCap, uint256 newCap);
    event MonthlyCapSet(uint256 oldCap, uint256 newCap);
    event CategoryBudgetSet(bytes32 indexed category, uint256 oldBudget, uint256 newBudget);
    event GlobalCeilingLowered(uint256 oldCeiling, uint256 newCeiling);
    event PendingTtlSet(uint256 oldTtl, uint256 newTtl);
    event NonceInvalidated(uint256 indexed nonce);
    event MaxOpenPendingSet(uint256 oldMax, uint256 newMax);
    event Withdrawn(address indexed to, uint256 amount);

    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed category,
        bytes32 reasonHash,
        bool ownerApproved
    );
    event PaymentPending(
        bytes32 indexed paymentId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed category,
        bytes32 reasonHash,
        uint8 overLimits,
        uint64 expiresAt,
        bytes32 invoiceKey,
        uint32 agentEpoch,
        uint32 payeeEpoch
    );
    event PaymentApproved(bytes32 indexed paymentId, address indexed approver, bytes32 reasonHash);
    event PaymentRejected(bytes32 indexed paymentId, bytes32 reasonHash);
    event PaymentExpired(bytes32 indexed paymentId, bytes32 reasonHash);

    // ------------------------------------------------------------------ errors

    error NotAgent();
    error ZeroAddress();
    error InvalidAgent(address account);
    error InvalidPayee(address payee);
    error InvalidCategory();
    error WrongTokenDecimals(uint8 decimals);
    error InvalidPaymentId();
    error ZeroAmount();
    error PaymentIdUsed(bytes32 paymentId);
    error PayeeNotAllowed(address payee);
    error CategoryMismatch(bytes32 expected, bytes32 given);
    error GlobalCeilingExceeded(uint256 totalPaid, uint256 amount, uint256 ceiling);
    error CeilingCanOnlyDecrease(uint256 current, uint256 requested);
    error CeilingTooHigh(uint256 ceiling);
    error InsufficientBalance(uint256 balance, uint256 amount);
    error NotPending(bytes32 paymentId);
    error ApprovalWindowClosed(bytes32 paymentId, uint64 expiresAt);
    error NotYetExpired(bytes32 paymentId, uint64 expiresAt);
    error InvalidPendingTtl(uint256 ttl);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();
    error NonceAlreadyUsed(uint256 nonce);
    error RenounceDisabled();
    error InvalidOwner(address account);
    error InvoiceAlreadyUsed(bytes32 invoiceKey, bytes32 paymentId);
    error TooManyOpenPending(uint256 maxOpenPending);
    error StaleAgentEpoch(bytes32 paymentId, uint32 requested, uint32 current);
    error StalePayeeEpoch(bytes32 paymentId, uint32 requested, uint32 current);

    // ------------------------------------------------------------------ modifiers

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    // ------------------------------------------------------------------ constructor

    constructor(
        IERC20 token_,
        address owner_,
        address agent_,
        uint256 perPaymentCap_,
        uint256 monthlyCap_,
        uint256 globalCeiling_,
        uint256 pendingTtl_
    ) Ownable(owner_) EIP712("Payday SpendPolicy", "1") {
        if (address(token_) == address(0) || agent_ == address(0)) revert ZeroAddress();
        if (agent_ == owner_) revert InvalidAgent(agent_);
        uint8 dec = IERC20Metadata(address(token_)).decimals();
        if (dec != TOKEN_DECIMALS) revert WrongTokenDecimals(dec);
        if (pendingTtl_ < MIN_PENDING_TTL || pendingTtl_ > MAX_PENDING_TTL) revert InvalidPendingTtl(pendingTtl_);
        // Bound the ceiling so bucket sums always fit in uint192 (2^128 units is ~3.4e32 USDC).
        if (globalCeiling_ > type(uint128).max) revert CeilingTooHigh(globalCeiling_);

        token = token_;
        agent = agent_;
        perPaymentCap = perPaymentCap_;
        monthlyCap = monthlyCap_;
        globalCeiling = globalCeiling_;
        pendingTtl = pendingTtl_;
        maxOpenPending = DEFAULT_MAX_OPEN_PENDING;

        emit AgentChanged(address(0), agent_);
        emit PerPaymentCapSet(0, perPaymentCap_);
        emit MonthlyCapSet(0, monthlyCap_);
        emit GlobalCeilingLowered(type(uint256).max, globalCeiling_);
        emit PendingTtlSet(0, pendingTtl_);
        emit MaxOpenPendingSet(0, DEFAULT_MAX_OPEN_PENDING);
    }

    // ================================================================== agent path

    /// @notice The ONLY function the agent can use to move funds.
    /// @dev    Hard rules (auth, pause, unused id, allow-list, category, global ceiling, balance) revert.
    ///         Soft limits (per-payment, monthly, category, payee caps) never revert: the request is
    ///         parked as Pending for the owner. Pending requests do NOT reserve budget; budgets are
    ///         consumed only when money actually moves.
    ///         `invoiceKey` (optional, 0 = none) is a deterministic invoice identifier; while a payment
    ///         holding it is Pending or Executed, no other payment may use it (L-01). It only helps if
    ///         the key is derived by code the agent's model cannot influence (see README).
    /// @return status Executed (paid now) or Pending (waiting for owner).
    function requestPayment(
        bytes32 paymentId,
        address payee,
        uint256 amount,
        bytes32 category,
        bytes32 reasonHash,
        bytes32 invoiceKey
    ) external nonReentrant onlyAgent whenNotPaused returns (Status status) {
        if (paymentId == bytes32(0)) revert InvalidPaymentId();
        if (_payments[paymentId].status != Status.None) revert PaymentIdUsed(paymentId);
        if (amount == 0) revert ZeroAmount();
        if (invoiceKey != bytes32(0)) {
            bytes32 holder = invoicePayment[invoiceKey];
            if (holder != bytes32(0)) revert InvoiceAlreadyUsed(invoiceKey, holder);
            invoicePayment[invoiceKey] = paymentId;
        }
        Payee storage p = _payees[payee];
        if (!p.allowed) revert PayeeNotAllowed(payee);
        if (p.category != category) revert CategoryMismatch(p.category, category);
        // The ceiling only ever goes down and totalPaid only goes up, so an over-ceiling request
        // could never be approved later; refuse it outright.
        if (totalPaid + amount > globalCeiling) revert GlobalCeilingExceeded(totalPaid, amount, globalCeiling);

        uint8 over = _overLimits(payee, p.cap, amount, category);
        uint32 pEpoch = payeeEpoch[payee];
        if (over == 0) {
            _payments[paymentId] =
                Payment(payee, Status.Executed, 0, amount, category, reasonHash, invoiceKey, agentEpoch, pEpoch);
            _execute(paymentId, payee, amount, category, reasonHash, false);
            return Status.Executed;
        }

        if (openPending >= maxOpenPending) revert TooManyOpenPending(maxOpenPending);
        ++openPending;
        uint64 expiresAt = SafeCast.toUint64(block.timestamp + pendingTtl);
        _payments[paymentId] =
            Payment(payee, Status.Pending, expiresAt, amount, category, reasonHash, invoiceKey, agentEpoch, pEpoch);
        emit PaymentPending(
            paymentId, payee, amount, category, reasonHash, over, expiresAt, invoiceKey, agentEpoch, pEpoch
        );
        return Status.Pending;
    }

    /// @notice Anyone may mark an expired pending payment as Expired (bookkeeping only).
    function expirePending(bytes32 paymentId) external {
        Payment storage pm = _payments[paymentId];
        if (pm.status != Status.Pending) revert NotPending(paymentId);
        if (block.timestamp <= pm.expiresAt) revert NotYetExpired(paymentId, pm.expiresAt);
        pm.status = Status.Expired;
        _closePending(pm);
        emit PaymentExpired(paymentId, pm.reasonHash);
    }

    // ================================================================== owner decisions

    /// @notice Owner approves a pending payment. Soft limits are overridden; hard rules are re-checked.
    function approvePending(bytes32 paymentId) external nonReentrant onlyOwner whenNotPaused {
        _approve(paymentId, msg.sender);
    }

    /// @notice Same as approvePending, but authorised by an EIP-712 signature from the owner, so a
    ///         relayer / sponsored transaction can submit it. Domain binds chainId + this contract; the
    ///         struct binds all payment fields and the ownerEpoch. EOA (ECDSA) and ERC-1271 owners.
    function approvePendingWithSig(bytes32 paymentId, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (nonceUsed[nonce]) revert NonceAlreadyUsed(nonce);
        address signer = owner();
        if (!_isValidSignatureNow(signer, approvalDigest(paymentId, nonce, deadline), signature)) {
            revert InvalidSignature();
        }
        nonceUsed[nonce] = true;
        _approve(paymentId, signer);
    }

    /// @notice Owner rejects a pending payment. The id stays burned forever; the invoiceKey is released.
    ///         This is the only way to close a pending payment early (the agent cannot cancel, L-06).
    function rejectPending(bytes32 paymentId) external onlyOwner {
        Payment storage pm = _payments[paymentId];
        if (pm.status != Status.Pending) revert NotPending(paymentId);
        pm.status = Status.Rejected;
        _closePending(pm);
        emit PaymentRejected(paymentId, pm.reasonHash);
    }

    /// @notice Owner pulls funds out (e.g. to retire this policy). Not counted against the ceiling,
    ///         which bounds agent-initiated outflow. The agent has no equivalent.
    function withdraw(address to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        emit Withdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    // ================================================================== owner settings

    /// @notice Rotate the agent key. Bumps agentEpoch, so every Pending payment requested by an
    ///         earlier key can no longer be approved (L-02). The old key can never be allow-listed.
    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        if (newAgent == owner() || newAgent == pendingOwner() || _payees[newAgent].allowed) {
            revert InvalidAgent(newAgent);
        }
        emit AgentChanged(agent, newAgent);
        wasAgent[agent] = true;
        agent = newAgent;
        ++agentEpoch;
    }

    /// @notice Add or update an allow-listed payee. (Re-)adding a payee that is not currently
    ///         allowed bumps its payeeEpoch, so Pending payments from before a removal stay dead (L-03).
    function setPayee(address payee, string calldata label, bytes32 category, uint256 cap) external onlyOwner {
        if (
            payee == address(0) || payee == address(this) || payee == address(token) || payee == agent
                || wasAgent[payee] || payee == owner() || payee == pendingOwner()
        ) revert InvalidPayee(payee);
        if (category == bytes32(0)) revert InvalidCategory();
        if (!_payees[payee].allowed) ++payeeEpoch[payee];
        _payees[payee] = Payee(true, category, cap, label);
        emit PayeeSet(payee, label, category, cap);
    }

    function removePayee(address payee) external onlyOwner {
        if (!_payees[payee].allowed) revert PayeeNotAllowed(payee);
        delete _payees[payee];
        ++payeeEpoch[payee];
        emit PayeeRemoved(payee);
    }

    /// @notice Limit on simultaneously open Pending payments (L-06). 0 = no new Pending at all.
    function setMaxOpenPending(uint256 newMax) external onlyOwner {
        emit MaxOpenPendingSet(maxOpenPending, newMax);
        maxOpenPending = newMax;
    }

    function setPerPaymentCap(uint256 newCap) external onlyOwner {
        emit PerPaymentCapSet(perPaymentCap, newCap);
        perPaymentCap = newCap;
    }

    function setMonthlyCap(uint256 newCap) external onlyOwner {
        emit MonthlyCapSet(monthlyCap, newCap);
        monthlyCap = newCap;
    }

    function setCategoryBudget(bytes32 category, uint256 newBudget) external onlyOwner {
        if (category == bytes32(0)) revert InvalidCategory();
        emit CategoryBudgetSet(category, categoryBudget[category], newBudget);
        categoryBudget[category] = newBudget;
    }

    /// @notice The mainnet exposure cap. Can only go DOWN. To allow more, deploy a fresh policy.
    function lowerGlobalCeiling(uint256 newCeiling) external onlyOwner {
        if (newCeiling >= globalCeiling) revert CeilingCanOnlyDecrease(globalCeiling, newCeiling);
        emit GlobalCeilingLowered(globalCeiling, newCeiling);
        globalCeiling = newCeiling;
    }

    function setPendingTtl(uint256 newTtl) external onlyOwner {
        if (newTtl < MIN_PENDING_TTL || newTtl > MAX_PENDING_TTL) revert InvalidPendingTtl(newTtl);
        emit PendingTtlSet(pendingTtl, newTtl);
        pendingTtl = newTtl;
    }

    /// @notice Burn an EIP-712 nonce so an already-signed approval can never be used.
    function invalidateNonce(uint256 nonce) external onlyOwner {
        if (nonceUsed[nonce]) revert NonceAlreadyUsed(nonce);
        nonceUsed[nonce] = true;
        emit NonceInvalidated(nonce);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Ownership can never be given to the agent key, nor to an allow-listed payee (L-05).
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == agent) revert InvalidAgent(newOwner);
        if (_payees[newOwner].allowed) revert InvalidOwner(newOwner);
        super.transferOwnership(newOwner);
    }

    /// @dev L-05: a pending owner that became an allow-listed payee in the meantime cannot accept;
    ///      the current owner must removePayee first. (setPayee also refuses the pending owner, so
    ///      this is defence in depth.) The payee is never silently removed.
    function acceptOwnership() public override {
        if (_payees[msg.sender].allowed) revert InvalidOwner(msg.sender);
        super.acceptOwnership();
    }

    /// @dev Every ownership change bumps ownerEpoch, so signatures from any earlier tenure (even of the
    ///      same address after A -> B -> A) are dead (L-04).
    function _transferOwnership(address newOwner) internal override {
        super._transferOwnership(newOwner);
        ++ownerEpoch;
    }

    /// @dev Renouncing would strand the funds and leave nobody able to pause. Disabled.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ================================================================== views

    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return _payments[paymentId];
    }

    function getPayee(address payee) external view returns (Payee memory) {
        return _payees[payee];
    }

    /// @notice Spent in the current rolling window (today + previous 30 UTC days).
    function spentInWindow() external view returns (uint256) {
        return _windowSum(_totalWindow);
    }

    function categorySpentInWindow(bytes32 category) external view returns (uint256) {
        return _windowSum(_categoryWindow[category]);
    }

    function payeeSpentInWindow(address payee) external view returns (uint256) {
        return _windowSum(_payeeWindow[payee]);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest the owner must sign to approve `paymentId` under the current ownerEpoch.
    function approvalDigest(bytes32 paymentId, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        Payment storage pm = _payments[paymentId];
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    APPROVE_TYPEHASH,
                    paymentId,
                    pm.payee,
                    pm.amount,
                    pm.category,
                    pm.reasonHash,
                    pm.expiresAt,
                    ownerEpoch,
                    nonce,
                    deadline
                )
            )
        );
    }

    // ================================================================== internals

    function _approve(bytes32 paymentId, address approver) internal {
        Payment storage pm = _payments[paymentId];
        if (pm.status != Status.Pending) revert NotPending(paymentId);
        if (block.timestamp > pm.expiresAt) revert ApprovalWindowClosed(paymentId, pm.expiresAt);
        if (pm.agentEpoch != agentEpoch) revert StaleAgentEpoch(paymentId, pm.agentEpoch, agentEpoch);
        Payee storage p = _payees[pm.payee];
        if (!p.allowed) revert PayeeNotAllowed(pm.payee);
        uint32 pEpoch = payeeEpoch[pm.payee];
        if (pm.payeeEpoch != pEpoch) revert StalePayeeEpoch(paymentId, pm.payeeEpoch, pEpoch);
        bytes32 category = p.category; // charge the payee's CURRENT category, which must still match
        if (category != pm.category) revert CategoryMismatch(category, pm.category);
        if (totalPaid + pm.amount > globalCeiling) {
            revert GlobalCeilingExceeded(totalPaid, pm.amount, globalCeiling);
        }
        pm.status = Status.Executed;
        --openPending;
        emit PaymentApproved(paymentId, approver, pm.reasonHash);
        _execute(paymentId, pm.payee, pm.amount, category, pm.reasonHash, true);
    }

    /// @dev I-01: same logic as OZ 5.4 `SignatureChecker.isValidSignatureNow` (ECDSA for code-less
    ///      owners, ERC-1271 `isValidSignature` for contract owners). Inlined because OZ 5.4's
    ///      SignatureChecker imports `Bytes.sol`, which uses MCOPY and cannot compile for `paris`.
    function _isValidSignatureNow(address signer, bytes32 hash, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }
        (bool success, bytes memory result) =
            signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (hash, signature)));
        return
            success && result.length >= 32
                && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @dev Bookkeeping for Pending -> Rejected / Expired: free the slot and the invoiceKey.
    function _closePending(Payment storage pm) internal {
        --openPending;
        if (pm.invoiceKey != bytes32(0)) delete invoicePayment[pm.invoiceKey];
    }

    /// @dev Effects first, then the single external transfer (checks-effects-interactions).
    ///      If the token transfer fails (e.g. USDC-blocklisted payee) the whole tx reverts, so no
    ///      state - status, totals, buckets - is left behind.
    function _execute(
        bytes32 paymentId,
        address payee,
        uint256 amount,
        bytes32 category,
        bytes32 reasonHash,
        bool ownerApproved
    ) internal {
        uint256 bal = token.balanceOf(address(this));
        if (bal < amount) revert InsufficientBalance(bal, amount);
        totalPaid += amount;
        _record(_totalWindow, amount);
        _record(_categoryWindow[category], amount);
        _record(_payeeWindow[payee], amount);
        emit PaymentExecuted(paymentId, payee, amount, category, reasonHash, ownerApproved);
        token.safeTransfer(payee, amount);
    }

    function _overLimits(address payee, uint256 payeeCap, uint256 amount, bytes32 category)
        internal
        view
        returns (uint8 over)
    {
        if (amount > perPaymentCap) over |= OVER_PER_PAYMENT_CAP;
        if (_windowSum(_totalWindow) + amount > monthlyCap) over |= OVER_MONTHLY_CAP;
        if (_windowSum(_categoryWindow[category]) + amount > categoryBudget[category]) over |= OVER_CATEGORY_BUDGET;
        if (payeeCap != 0 && _windowSum(_payeeWindow[payee]) + amount > payeeCap) over |= OVER_PAYEE_CAP;
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @dev Bounded loop: always exactly 31 iterations.
    function _windowSum(Bucket[BUCKETS] storage window) internal view returns (uint256 sum) {
        uint256 today = _today();
        for (uint256 i; i < BUCKETS; ++i) {
            Bucket storage b = window[i];
            if (b.day + WINDOW_DAYS >= today) sum += b.amount;
        }
    }

    function _record(Bucket[BUCKETS] storage window, uint256 amount) internal {
        uint256 today = _today();
        Bucket storage b = window[today % BUCKETS];
        if (b.day == today) {
            b.amount = SafeCast.toUint192(uint256(b.amount) + amount);
        } else {
            b.day = SafeCast.toUint64(today);
            b.amount = SafeCast.toUint192(amount);
        }
    }
}
