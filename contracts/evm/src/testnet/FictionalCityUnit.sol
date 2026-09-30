// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TESTNET ONLY: fixed-supply fictional units. No company, land or membership rights.
/// @dev The deploying issuer chooses the initial inventory recipient once; nobody can mint later.
contract FictionalCityUnit {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;
    address public immutable issuer;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory unitName, string memory unitSymbol, uint256 supply) {
        require(block.chainid == 46630 || block.chainid == 31337, "TESTNET_ONLY");
        require(bytes(unitName).length != 0 && bytes(unitSymbol).length != 0 && supply != 0, "CONFIG");
        name = unitName;
        symbol = unitSymbol;
        issuer = msg.sender;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
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
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "ZERO_RECIPIENT");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
