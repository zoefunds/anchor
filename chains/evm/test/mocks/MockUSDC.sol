// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// A minimal 6-decimal ERC-20 standing in for Circle's real Sepolia USDC
// in tests — real token behavior (transferFrom/approve/balanceOf via
// OZ's audited ERC20), not a hand-rolled mock, so EscrowUSDC.t.sol
// exercises the actual SafeERC20 code paths.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// Deliberately broken: charges a 1% fee on every transfer, burning it —
// the exact "moved less than requested" behavior EscrowUSDC.deposit()'s
// balance-delta check must catch and reject. Also 6 decimals, same
// shape as MockUSDC, so tests can swap one for the other without
// touching amount math.
contract FeeOnTransferMockUSDC is ERC20 {
    uint256 public constant FEE_BPS = 100;

    constructor() ERC20("Fee USD Coin", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount - fee);
        _burn(from, fee);
        return true;
    }
}
