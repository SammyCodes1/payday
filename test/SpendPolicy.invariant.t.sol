// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Drives the policy with agent requests (incl. id / invoiceKey reuse and attacks), owner
///         decisions (on-chain and EIP-712), payee changes, agent rotation, ownership transfer, cap
///         changes, brief pauses and time warps (incl. window edges).
/// @dev    T-01: every call's outcome is PREDICTED from an independent ghost model. A revert whose
///         selector differs from the prediction, or a success where a revert was predicted (or vice
///         versa), counts as `unexpected`, which fails the run. Successes are counted too and a run
///         with zero successes fails (see afterInvariant).
contract Handler is Test {
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    bytes32 internal constant APPROVE_TYPEHASH_EXPECTED = keccak256(
        "ApprovePending(bytes32 paymentId,address payee,uint256 amount,bytes32 category,bytes32 reasonHash,uint64 expiresAt,uint256 ownerEpoch,uint256 nonce,uint256 deadline)"
    );

    SpendPolicy public policy;
    MockUSDC public usdc;
    address public outsider; // never allow-listed, never owner/agent
    address[3] public payees;
    uint256[3] public payeeCaps; // never changed by the handler
    bytes32[2] public catPool;

    uint256 public immutable initialCeiling;
    uint256 public immutable origPerPayment;
    uint256 public immutable origMonthly;
    uint256 public immutable origCatBudget;

    // ---------------------------------------------------------------- actors
    uint256[3] internal ownerKeys;
    address[3] public owners;
    address[3] public agents;
    uint8 public ownerIdx; // current owner
    uint8 public pendingOwnerIdx = 255; // 255 = none
    uint8 public agentIdx;
    bool[3] public wasAgentG;

    // ---------------------------------------------------------------- ghost model
    struct G {
        uint8 status; // mirrors SpendPolicy.Status
        uint8 pi;
        uint256 amount;
        bytes32 cat;
        bytes32 reason;
        bytes32 invoiceKey;
        uint64 expiresAt;
        uint32 agentRot;
        uint32 payeeVer;
    }

    mapping(bytes32 => G) internal g;
    mapping(bytes32 => bytes32) internal invoiceHolder;
    mapping(bytes32 => uint256) public invoiceExecCount;
    mapping(uint256 => bool) internal nonceUsedG;
    bool[3] public payeeAllowed;
    bytes32[3] public payeeCat;
    uint32[3] public payeeVer;
    uint32 public agentRot;
    uint32 public ownerEpochG;
    uint256 public ttlG;
    uint256 public openPendingG;

    uint256[] internal exTs;
    uint256[] internal exAmt;
    uint8[] internal exPi;
    bytes32[] internal exCat;

    uint256 public autoTotal;
    uint256 public approvedTotal;
    uint256 public withdrawnTotal;
    bytes32[] public usedIds;
    bytes32[] public pendingIds;
    mapping(bytes32 => uint256) public execCount;
    uint256 internal idCounter;

    struct Sig {
        bytes32 id;
        uint256 nonce;
        uint256 deadline;
        uint32 epoch; // ownerEpoch at signing time
        bool byOwner; // signed by the owner of that epoch
        bytes sig;
    }

    Sig[] internal sigs;

    // ---------------------------------------------------------------- outcome counters (T-01)
    uint256 public successes;
    uint256 public expectedReverts;
    uint256 public unexpected;
    string public lastUnexpected;
    mapping(string => uint256) public okBy;
    mapping(string => uint256) public expRevBy;

    // ---------------------------------------------------------------- breach flags
    bool public breachDoubleUse;
    bool public breachAgentSetting;
    bool public breachOutsiderPaid;
    bool public breachStrangerApproved;
    bool public breachCeiling;
    bool public breachPerPayment;
    bool public breachWindow; // auto payment pushed some 30x24h span over a cap in force at that time
    bool public breachMisconfig; // owner could make a forbidden role/payee combination (L-05)

    constructor(SpendPolicy p, MockUSDC u, address out, address[3] memory ps, bytes32[2] memory cs) {
        policy = p;
        usdc = u;
        outsider = out;
        payees = ps;
        catPool = cs;
        initialCeiling = p.globalCeiling();
        origPerPayment = p.perPaymentCap();
        origMonthly = p.monthlyCap();
        origCatBudget = p.categoryBudget(cs[0]);
        uint32[3] memory ok = [uint32(0), 10, 11];
        uint32[3] memory ak = [uint32(2), 12, 13];
        for (uint256 i; i < 3; ++i) {
            ownerKeys[i] = vm.deriveKey(MNEMONIC, ok[i]);
            owners[i] = vm.addr(ownerKeys[i]);
            agents[i] = vm.addr(vm.deriveKey(MNEMONIC, ak[i]));
            SpendPolicy.Payee memory pe = p.getPayee(ps[i]);
            payeeAllowed[i] = pe.allowed;
            payeeCat[i] = pe.category;
            payeeCaps[i] = pe.cap;
            payeeVer[i] = p.payeeEpoch(ps[i]);
        }
        require(p.owner() == owners[0] && p.agent() == agents[0], "fixture");
        ownerEpochG = p.ownerEpoch();
        agentRot = p.agentEpoch();
        ttlG = p.pendingTtl();
    }

    // ================================================================ outcome bookkeeping

    function _sel(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length >= 4) s = bytes4(err);
    }

    function _ok(string memory action, bytes4 predicted) internal {
        if (predicted == bytes4(0)) {
            ++successes;
            ++okBy[action];
        } else {
            _unexpected(
                string.concat(action, ": succeeded, predicted revert ", vm.toString(abi.encodePacked(predicted)))
            );
        }
    }

    function _reverted(string memory action, bytes4 predicted, bytes memory err) internal {
        if (predicted != bytes4(0) && _sel(err) == predicted) {
            ++expectedReverts;
            ++expRevBy[action];
        } else {
            _unexpected(
                string.concat(
                    action, ": reverted ", vm.toString(err), " predicted ", vm.toString(abi.encodePacked(predicted))
                )
            );
        }
    }

    function _unexpected(string memory why) internal {
        ++unexpected;
        lastUnexpected = why;
    }

    function owner() public view returns (address) {
        return owners[ownerIdx];
    }

    function agent() public view returns (address) {
        return agents[agentIdx];
    }

    // ================================================================ ghost windows

    /// Contract semantics, computed independently: spend on calendar days today-30..today.
    function _calSum(uint8 filter, bytes32 cat) internal view returns (uint256 sum) {
        uint256 today = block.timestamp / 1 days;
        for (uint256 i; i < exTs.length; ++i) {
            if (exTs[i] / 1 days + 30 < today) continue;
            if (filter < 3 && exPi[i] != filter) continue;
            if (cat != bytes32(0) && exCat[i] != cat) continue;
            sum += exAmt[i];
        }
    }

    /// Weaker, contract-agnostic property: spend in the last 30 x 24h.
    function _spanSum(uint8 filter, bytes32 cat) internal view returns (uint256 sum) {
        for (uint256 i; i < exTs.length; ++i) {
            if (exTs[i] + 30 days <= block.timestamp) continue;
            if (filter < 3 && exPi[i] != filter) continue;
            if (cat != bytes32(0) && exCat[i] != cat) continue;
            sum += exAmt[i];
        }
    }

    function _recordExec(bytes32 id, uint8 pi, uint256 amount, bytes32 cat) internal {
        exTs.push(block.timestamp);
        exAmt.push(amount);
        exPi.push(pi);
        exCat.push(cat);
        ++execCount[id];
        bytes32 k = g[id].invoiceKey;
        if (k != bytes32(0)) ++invoiceExecCount[k];
        if (policy.totalPaid() > policy.globalCeiling()) breachCeiling = true;
    }

    function _totalPaidG() internal view returns (uint256) {
        return autoTotal + approvedTotal;
    }

    // ================================================================ agent actions

    function requestBurst(uint256 seed, uint8 count) external {
        count = uint8(bound(count, 1, 6));
        for (uint256 i; i < count; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            _request(r, r >> 64, uint8(r >> 128));
        }
    }

    function request(uint256 seed, uint256 amount, uint8 flags) external {
        _request(seed, amount, flags);
    }

    /// flags bit0: reuse an id; bit1: wrong category; bit2,3: invoiceKey from a small pool; bit4: amount == cap
    function _request(uint256 seed, uint256 amount, uint8 flags) internal {
        uint8 pi = uint8(seed % 3);
        bytes32 id = (flags & 1 != 0 && usedIds.length > 0)
            ? usedIds[seed % usedIds.length]
            : keccak256(abi.encode("inv", ++idCounter));
        amount = flags & 16 != 0 ? policy.perPaymentCap() : bound(amount, 1, 2 * origPerPayment);
        bytes32 cat = flags & 2 != 0 ? catPool[(seed >> 8) % 2] : payeeCat[pi];
        if (cat == bytes32(0)) cat = catPool[0];
        bytes32 key = flags & 12 != 0 ? keccak256(abi.encode("invoice", (seed >> 16) % 6)) : bytes32(0);
        bytes32 reason = keccak256(abi.encode(seed));

        // ---- predict
        bytes4 pred;
        bool pend;
        if (amount == 0) pred = SpendPolicy.ZeroAmount.selector;
        if (g[id].status != 0) {
            pred = SpendPolicy.PaymentIdUsed.selector;
        } else if (pred == 0 && key != 0 && invoiceHolder[key] != 0) {
            pred = SpendPolicy.InvoiceAlreadyUsed.selector;
        } else if (pred == 0 && !payeeAllowed[pi]) {
            pred = SpendPolicy.PayeeNotAllowed.selector;
        } else if (pred == 0 && payeeCat[pi] != cat) {
            pred = SpendPolicy.CategoryMismatch.selector;
        } else if (pred == 0 && _totalPaidG() + amount > policy.globalCeiling()) {
            pred = SpendPolicy.GlobalCeilingExceeded.selector;
        }
        if (pred == 0) {
            pend = amount > policy.perPaymentCap() || _calSum(255, 0) + amount > policy.monthlyCap()
                || _calSum(255, cat) + amount > policy.categoryBudget(cat)
                || (payeeCaps[pi] != 0 && _calSum(pi, 0) + amount > payeeCaps[pi]);
            if (!pend && usdc.balanceOf(address(policy)) < amount) pred = SpendPolicy.InsufficientBalance.selector;
            if (pend && openPendingG >= policy.maxOpenPending()) pred = SpendPolicy.TooManyOpenPending.selector;
        }

        vm.prank(agent());
        try policy.requestPayment(id, payees[pi], amount, cat, reason, key) returns (SpendPolicy.Status s) {
            if (pred != 0) {
                _ok("request", pred);
                if (g[id].status != 0) breachDoubleUse = true;
                return;
            }
            if ((s == SpendPolicy.Status.Pending) != pend) {
                _unexpected(pend ? "request: executed, predicted pending" : "request: pending, predicted executed");
            } else {
                _ok("request", 0);
            }
            usedIds.push(id);
            g[id] = G(uint8(s), pi, amount, cat, reason, key, 0, agentRot, payeeVer[pi]);
            if (key != 0) invoiceHolder[key] = id;
            if (s == SpendPolicy.Status.Executed) {
                if (amount > policy.perPaymentCap()) breachPerPayment = true;
                // contract-agnostic 30 x 24h check against the caps in force right now
                if (
                    _spanSum(255, 0) + amount > policy.monthlyCap()
                        || _spanSum(255, cat) + amount > policy.categoryBudget(cat)
                        || (payeeCaps[pi] != 0 && _spanSum(pi, 0) + amount > payeeCaps[pi])
                ) breachWindow = true;
                autoTotal += amount;
                _recordExec(id, pi, amount, cat);
            } else {
                g[id].expiresAt = uint64(block.timestamp + ttlG);
                if (policy.getPayment(id).expiresAt != g[id].expiresAt) _unexpected("request: expiresAt");
                ++openPendingG;
                pendingIds.push(id);
            }
        } catch (bytes memory err) {
            _reverted("request", pred, err);
        }
    }

    /// The agent tries every way it might move money or loosen limits.
    function agentAttack(uint8 which, uint256 v) external {
        which = uint8(bound(which, 0, 13));
        bytes memory data;
        if (which == 0) {
            data = abi.encodeCall(SpendPolicy.setMonthlyCap, (type(uint256).max));
        } else if (which == 1) {
            data = abi.encodeCall(SpendPolicy.setPerPaymentCap, (type(uint256).max));
        } else if (which == 2) {
            data = abi.encodeCall(SpendPolicy.setCategoryBudget, (catPool[0], type(uint256).max));
        } else if (which == 3) {
            data = abi.encodeCall(SpendPolicy.setPayee, (outsider, "x", catPool[0], 0));
        } else if (which == 4) {
            data = abi.encodeCall(SpendPolicy.withdraw, (outsider, bound(v, 1, 1e12)));
        } else if (which == 5) {
            data = abi.encodeCall(SpendPolicy.setMaxOpenPending, (type(uint256).max));
        } else if (which == 6) {
            data = abi.encodeCall(SpendPolicy.transferOwnership, (outsider));
        } else if (which == 7) {
            data = abi.encodeCall(SpendPolicy.setAgent, (outsider));
        } else if (which == 8 || which == 9 || which == 10) {
            if (pendingIds.length == 0) return;
            bytes32 id = pendingIds[v % pendingIds.length];
            if (which == 8) data = abi.encodeCall(SpendPolicy.approvePending, (id));
            else if (which == 9) data = abi.encodeCall(SpendPolicy.rejectPending, (id));
            else data = abi.encodeWithSignature("cancelPending(bytes32)", id);
        } else if (which == 11) {
            data = abi.encodeCall(SpendPolicy.pause, ());
        } else if (which == 12) {
            data = abi.encodeCall(SpendPolicy.lowerGlobalCeiling, (0));
        } else {
            data = abi.encodeCall(
                SpendPolicy.requestPayment,
                (keccak256(abi.encode("evil", v)), outsider, bound(v, 1, origPerPayment), catPool[0], 0, 0)
            );
        }
        vm.prank(agent());
        (bool ok,) = address(policy).call(data);
        if (ok) breachAgentSetting = true;
        else ++expectedReverts;
        if (usdc.balanceOf(outsider) != 0) breachOutsiderPaid = true;
    }

    function strangerApprove(uint256 seed) external {
        if (pendingIds.length == 0) return;
        vm.prank(outsider);
        try policy.approvePending(pendingIds[seed % pendingIds.length]) {
            breachStrangerApproved = true;
        } catch (bytes memory err) {
            _reverted("strangerApprove", Ownable.OwnableUnauthorizedAccount.selector, err);
        }
    }

    // ================================================================ owner decisions

    function _predictApprove(bytes32 id) internal view returns (bytes4) {
        G storage x = g[id];
        if (x.status != 1) return SpendPolicy.NotPending.selector;
        if (block.timestamp > x.expiresAt) return SpendPolicy.ApprovalWindowClosed.selector;
        if (x.agentRot != agentRot) return SpendPolicy.StaleAgentEpoch.selector;
        if (!payeeAllowed[x.pi]) return SpendPolicy.PayeeNotAllowed.selector;
        if (x.payeeVer != payeeVer[x.pi]) return SpendPolicy.StalePayeeEpoch.selector;
        if (payeeCat[x.pi] != x.cat) return SpendPolicy.CategoryMismatch.selector;
        if (_totalPaidG() + x.amount > policy.globalCeiling()) return SpendPolicy.GlobalCeilingExceeded.selector;
        if (usdc.balanceOf(address(policy)) < x.amount) return SpendPolicy.InsufficientBalance.selector;
        return 0;
    }

    function _approved(bytes32 id) internal {
        G storage x = g[id];
        if (x.agentRot != agentRot || x.payeeVer != payeeVer[x.pi] || payeeCat[x.pi] != x.cat) {
            _unexpected("approved a stale pending");
        }
        x.status = 2;
        --openPendingG;
        approvedTotal += x.amount;
        _recordExec(id, x.pi, x.amount, x.cat);
    }

    function _pickId(uint256 seed) internal view returns (bytes32) {
        if (pendingIds.length == 0) return keccak256(abi.encode("none", seed));
        return pendingIds[seed % pendingIds.length];
    }

    function ownerApprove(uint256 seed) external {
        bytes32 id = _pickId(seed);
        bytes4 pred = _predictApprove(id);
        vm.prank(owner());
        try policy.approvePending(id) {
            _ok("ownerApprove", pred);
            if (pred == 0) _approved(id);
        } catch (bytes memory err) {
            _reverted("ownerApprove", pred, err);
        }
    }

    function _digest(bytes32 id, uint256 nonce, uint256 deadline, uint32 epoch) internal view returns (bytes32) {
        G storage x = g[id];
        bytes32 sh = keccak256(
            abi.encode(
                APPROVE_TYPEHASH_EXPECTED,
                id,
                x.status == 0 ? address(0) : payees[x.pi],
                x.amount,
                x.cat,
                x.reason,
                x.expiresAt,
                uint256(epoch),
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", policy.domainSeparator(), sh));
    }

    /// mode 0: fresh owner signature, relayed now; 1: fresh owner signature, stored for later replay;
    /// 2: replay a stored signature (maybe from an earlier ownerEpoch / used nonce / past deadline);
    /// 3: signature by a key that is not the current owner.
    function sigApprove(uint256 seed, uint8 mode, uint8 nonceSeed, uint32 dl) external {
        mode = uint8(bound(mode, 0, 3));
        Sig memory s;
        if (mode == 2) {
            if (sigs.length == 0) return;
            s = sigs[seed % sigs.length];
        } else {
            s.id = _pickId(seed);
            s.nonce = nonceSeed % 16;
            s.deadline = block.timestamp + bound(dl, 0, 3 days);
            s.epoch = ownerEpochG;
            uint256 key = ownerKeys[ownerIdx];
            s.byOwner = mode != 3;
            if (mode == 3) key = ownerKeys[(ownerIdx + 1 + seed % 2) % 3];
            (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, _digest(s.id, s.nonce, s.deadline, ownerEpochG));
            s.sig = abi.encodePacked(r, ss, v);
            if (mode == 1) {
                sigs.push(s);
                return;
            }
        }
        bytes4 pred;
        if (block.timestamp > s.deadline) pred = SpendPolicy.SignatureExpired.selector;
        else if (nonceUsedG[s.nonce]) pred = SpendPolicy.NonceAlreadyUsed.selector;
        else if (!s.byOwner || s.epoch != ownerEpochG) pred = SpendPolicy.InvalidSignature.selector;
        else pred = _predictApprove(s.id);

        vm.prank(outsider);
        try policy.approvePendingWithSig(s.id, s.nonce, s.deadline, s.sig) {
            _ok("sigApprove", pred);
            if (pred == 0) {
                nonceUsedG[s.nonce] = true;
                _approved(s.id);
            }
        } catch (bytes memory err) {
            _reverted("sigApprove", pred, err);
        }
    }

    function ownerReject(uint256 seed) external {
        bytes32 id = _pickId(seed);
        bytes4 pred = g[id].status == 1 ? bytes4(0) : SpendPolicy.NotPending.selector;
        vm.prank(owner());
        try policy.rejectPending(id) {
            _ok("ownerReject", pred);
            if (pred == 0) _close(id, 3);
        } catch (bytes memory err) {
            _reverted("ownerReject", pred, err);
        }
    }

    function _close(bytes32 id, uint8 st) internal {
        g[id].status = st;
        --openPendingG;
        bytes32 k = g[id].invoiceKey;
        if (k != 0) delete invoiceHolder[k];
    }

    /// atBoundary: first warp to exactly expiresAt (must still be NotYetExpired).
    function anyoneExpire(uint256 seed, bool atBoundary) external {
        bytes32 id = _pickId(seed);
        if (atBoundary && g[id].status == 1 && g[id].expiresAt > block.timestamp) vm.warp(g[id].expiresAt);
        bytes4 pred;
        if (g[id].status != 1) pred = SpendPolicy.NotPending.selector;
        else if (block.timestamp <= g[id].expiresAt) pred = SpendPolicy.NotYetExpired.selector;
        try policy.expirePending(id) {
            _ok("expire", pred);
            if (pred == 0) _close(id, 5);
        } catch (bytes memory err) {
            _reverted("expire", pred, err);
        }
    }

    /// Pause, check that the agent is stopped, unpause (so the policy is never left paused).
    function ownerPauseBriefly(uint256 seed) external {
        vm.prank(owner());
        policy.pause();
        vm.prank(agent());
        try policy.requestPayment(keccak256(abi.encode("p", seed)), payees[0], 1, payeeCat[0], 0, 0) {
            _unexpected("request while paused");
        } catch (bytes memory err) {
            _reverted("pausedRequest", Pausable.EnforcedPause.selector, err);
        }
        vm.prank(owner());
        policy.unpause();
        ++successes;
    }

    function ownerLowerCeiling(uint256 v) external {
        uint256 cur = policy.globalCeiling();
        uint256 paid = policy.totalPaid();
        if (cur == 0 || paid >= cur) return;
        uint256 floor = cur > paid + 2 * origPerPayment ? cur - 2 * origPerPayment : paid;
        vm.prank(owner());
        policy.lowerGlobalCeiling(bound(v, floor, cur - 1));
        ++successes;
    }

    function ownerWithdraw(uint256 v) external {
        uint256 bal = usdc.balanceOf(address(policy));
        if (bal == 0) return;
        v = bound(v, 1, bal / 20 + 1);
        vm.prank(owner());
        policy.withdraw(owner(), v);
        withdrawnTotal += v;
        ++successes;
    }

    /// Cap changes, always within [0, original] so the original bounds stay valid.
    function ownerSetCaps(uint8 which, uint256 v) external {
        which = uint8(bound(which, 0, 5));
        vm.startPrank(owner());
        if (which == 0) {
            policy.setPerPaymentCap(bound(v, 0, origPerPayment));
        } else if (which == 1) {
            policy.setMonthlyCap(bound(v, 0, origMonthly));
        } else if (which == 2 || which == 3) {
            policy.setCategoryBudget(catPool[which - 2], bound(v, 0, origCatBudget));
        } else if (which == 4) {
            policy.setMaxOpenPending(bound(v, 0, 25));
        } else {
            ttlG = bound(v, 1 days, 8 days);
            policy.setPendingTtl(ttlG);
        }
        vm.stopPrank();
        ++successes;
    }

    /// Payee changes: remove, (re-)add or re-categorise. Caps stay as deployed.
    function ownerPayeeChange(uint8 pi, bool remove, bool otherCat) external {
        pi = uint8(pi % 3);
        vm.startPrank(owner());
        if (remove) {
            bytes4 pred = payeeAllowed[pi] ? bytes4(0) : SpendPolicy.PayeeNotAllowed.selector;
            try policy.removePayee(payees[pi]) {
                _ok("removePayee", pred);
                if (pred == 0) {
                    payeeAllowed[pi] = false;
                    ++payeeVer[pi];
                }
            } catch (bytes memory err) {
                _reverted("removePayee", pred, err);
            }
        } else {
            bytes32 cat = otherCat ? catPool[(payeeCat[pi] == catPool[0]) ? 1 : 0] : catPool[pi == 1 ? 1 : 0];
            try policy.setPayee(payees[pi], "p", cat, payeeCaps[pi]) {
                _ok("setPayee", 0);
                if (!payeeAllowed[pi]) ++payeeVer[pi];
                payeeAllowed[pi] = true;
                payeeCat[pi] = cat;
            } catch (bytes memory err) {
                _reverted("setPayee", 0, err);
            }
        }
        vm.stopPrank();
    }

    /// Agent rotation through a pool of three keys.
    function ownerRotateAgent(uint8 to) external {
        uint8 n = uint8(to % 3);
        vm.prank(owner());
        try policy.setAgent(agents[n]) {
            _ok("setAgent", 0);
            wasAgentG[agentIdx] = true;
            agentIdx = n;
            ++agentRot;
        } catch (bytes memory err) {
            _reverted("setAgent", 0, err);
        }
    }

    function ownerTransfer(uint8 to) external {
        uint8 n = uint8((ownerIdx + 1 + to % 2) % 3);
        vm.prank(owner());
        try policy.transferOwnership(owners[n]) {
            _ok("transferOwnership", 0);
            pendingOwnerIdx = n;
        } catch (bytes memory err) {
            _reverted("transferOwnership", 0, err);
        }
    }

    function pendingOwnerAccept() external {
        if (pendingOwnerIdx == 255) return;
        vm.prank(owners[pendingOwnerIdx]);
        try policy.acceptOwnership() {
            _ok("acceptOwnership", 0);
            ownerIdx = pendingOwnerIdx;
            pendingOwnerIdx = 255;
            ++ownerEpochG;
        } catch (bytes memory err) {
            _reverted("acceptOwnership", 0, err);
        }
    }

    /// L-05: the owner tries to create a forbidden role overlap. Every attempt must revert.
    function ownerMisconfig(uint8 which, uint8 k) external {
        which = uint8(bound(which, 0, 4));
        address target;
        bytes memory data;
        if (which == 0) {
            target = agent();
            data = abi.encodeCall(SpendPolicy.setPayee, (target, "x", catPool[0], 0));
        } else if (which == 1) {
            uint8 i = uint8(k % 3);
            if (!wasAgentG[i] || i == agentIdx) return;
            data = abi.encodeCall(SpendPolicy.setPayee, (agents[i], "x", catPool[0], 0));
        } else if (which == 2) {
            if (pendingOwnerIdx == 255) return;
            data = abi.encodeCall(SpendPolicy.setPayee, (owners[pendingOwnerIdx], "x", catPool[0], 0));
        } else if (which == 3) {
            uint8 i = uint8(k % 3);
            if (!payeeAllowed[i]) return;
            data = abi.encodeCall(SpendPolicy.setAgent, (payees[i]));
        } else {
            uint8 i = uint8(k % 3);
            if (!payeeAllowed[i]) return;
            data = abi.encodeCall(SpendPolicy.transferOwnership, (payees[i]));
        }
        vm.prank(owner());
        (bool ok,) = address(policy).call(data);
        if (ok) breachMisconfig = true;
        else ++expectedReverts;
    }

    // ================================================================ time

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 4 days));
    }

    /// Jump to the last seconds of the current UTC day.
    function warpToDayEnd(uint256 s) external {
        uint256 t = (block.timestamp / 1 days + 1) * 1 days - bound(s, 1, 120);
        if (t > block.timestamp) vm.warp(t);
    }

    /// Jump to the first hour of day D+30 for an earlier payment on day D: the window edge.
    function warpToWindowEdge(uint256 s) external {
        if (exTs.length == 0) return;
        uint256 t = (exTs[s % exTs.length] / 1 days + 30) * 1 days + bound(s >> 8, 0, 3600);
        if (t > block.timestamp) vm.warp(t);
    }

    // ================================================================ views

    function usedIdsLength() external view returns (uint256) {
        return usedIds.length;
    }

    function pendingIdsLength() external view returns (uint256) {
        return pendingIds.length;
    }
}

contract SpendPolicyInvariantTest is Base {
    Handler internal handler;

    uint256 internal constant I_PER_PAYMENT = 500 * USDC;
    uint256 internal constant I_MONTHLY = 2_000 * USDC;
    uint256 internal constant I_OPS = 1_200 * USDC;
    uint256 internal constant I_SUP = 1_200 * USDC;
    uint256 internal constant I_PAYEE_C = 700 * USDC;
    uint256 internal constant I_CEILING = 4_000 * USDC;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        policy.setPerPaymentCap(I_PER_PAYMENT);
        policy.setMonthlyCap(I_MONTHLY);
        policy.setCategoryBudget(OPS, I_OPS);
        policy.setCategoryBudget(SUP, I_SUP);
        policy.setPayee(payeeC, "Generator repair", OPS, I_PAYEE_C);
        policy.lowerGlobalCeiling(I_CEILING);
        vm.stopPrank();
        handler = new Handler(policy, usdc, stranger, [payeeA, payeeB, payeeC], [OPS, SUP]);
        targetContract(address(handler));
    }

    /// 0. Every call's outcome matched the independent model (T-01).
    function invariant_noUnexpectedOutcome() public view {
        assertEq(handler.unexpected(), 0, handler.lastUnexpected());
    }

    /// 1. Total paid never exceeds the global ceiling (current, and the one set at deploy).
    function invariant_totalPaidNeverExceedsCeiling() public view {
        assertLe(policy.totalPaid(), policy.globalCeiling());
        assertLe(policy.totalPaid(), I_CEILING);
        assertFalse(handler.breachCeiling());
    }

    /// 2. Auto payments never push any 30 x 24h span over the caps in force at that moment.
    function invariant_windowCapHoldsExceptOwnerApproved() public view {
        assertFalse(handler.breachWindow());
        assertFalse(handler.breachPerPayment());
    }

    /// 3. No paymentId executes twice, a used id is never accepted again, and an invoiceKey is
    ///    paid at most once.
    function invariant_noPaymentIdExecutesTwice() public view {
        uint256 n = handler.usedIdsLength();
        for (uint256 i; i < n; ++i) {
            assertLe(handler.execCount(handler.usedIds(i)), 1);
        }
        for (uint256 k; k < 6; ++k) {
            assertLe(handler.invoiceExecCount(keccak256(abi.encode("invoice", k))), 1);
        }
        assertFalse(handler.breachDoubleUse());
    }

    /// 4. The agent cannot change settings or pay off-list; roles never overlap.
    function invariant_agentBoundedByCaps() public view {
        assertFalse(handler.breachAgentSetting());
        assertFalse(handler.breachOutsiderPaid());
        assertFalse(handler.breachStrangerApproved());
        assertFalse(handler.breachMisconfig());
        assertEq(usdc.balanceOf(stranger), 0);
        for (uint256 i; i < 3; ++i) {
            assertEq(usdc.balanceOf(handler.agents(i)), 0);
        }
        assertLe(policy.perPaymentCap(), I_PER_PAYMENT);
        assertLe(policy.monthlyCap(), I_MONTHLY);
        assertEq(policy.agent(), handler.agent());
        assertEq(policy.owner(), handler.owner());
        assertFalse(policy.getPayee(policy.owner()).allowed, "owner is a payee");
        assertFalse(policy.getPayee(policy.agent()).allowed, "agent is a payee");
    }

    /// 5. Accounting: every unit is either still held, paid to a payee, or withdrawn by the owner.
    function invariant_conservation() public view {
        assertEq(policy.totalPaid(), handler.autoTotal() + handler.approvedTotal());
        assertEq(usdc.balanceOf(payeeA) + usdc.balanceOf(payeeB) + usdc.balanceOf(payeeC), policy.totalPaid());
        assertEq(usdc.balanceOf(address(policy)) + policy.totalPaid() + handler.withdrawnTotal(), FUNDING);
    }

    /// 6. L-06: the open-pending counter matches the model; epochs match.
    function invariant_openPendingAndEpochs() public view {
        assertEq(policy.openPending(), handler.openPendingG());
        assertEq(policy.agentEpoch(), handler.agentRot());
        assertEq(policy.ownerEpoch(), handler.ownerEpochG());
    }

    /// Liveness (T-01): the run did something, and nothing unexpected happened.
    function afterInvariant() public view {
        assertGt(handler.successes(), 0, "zero successful calls");
        assertEq(handler.unexpected(), 0, handler.lastUnexpected());
    }
}
