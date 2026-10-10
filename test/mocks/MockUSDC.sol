// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal USDC stand-in with a Circle-style blocklist: transfers to or from a
///         blocklisted address revert (as FiatToken and Arc's runtime blocklist do).
contract MockUSDC is ERC20 {
    mapping(address => bool) public isBlacklisted;

    error Blacklisted(address account);

    constructor() ERC20("USD Coin (mock)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool flag) external {
        isBlacklisted[account] = flag;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (isBlacklisted[from]) revert Blacklisted(from);
        if (isBlacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}

/// @notice Token with the wrong decimals, to prove the constructor rejects it.
contract Mock18 is ERC20 {
    constructor() ERC20("Eighteen", "E18") {}
}
