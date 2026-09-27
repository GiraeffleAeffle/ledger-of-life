// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Fake test stock for the Robinhood testnet demo; not the official TSLA Stock Token.
contract FakeTestTSLA {
    string public constant name = "tTSLA fake test stock (no value)";
    string public constant symbol = "tTSLA";
    uint8 public constant decimals = 18;
    uint256 public constant MAX_MINT = 1_000e18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor() {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
    }

    function mint(address to, uint256 amount) external {
        require(amount <= MAX_MINT, "MINT_CAP");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 available = allowance[from][msg.sender];
        if (available != type(uint256).max) allowance[from][msg.sender] = available - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
