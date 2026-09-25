// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RentalEscrow} from "../src/RentalEscrow.sol";
import {MockUSDG, MockMorphoVault} from "./Mocks.sol";

interface RelayVm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert(bytes4) external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract Fixture1271Wallet {
    address public immutable owner;

    constructor(address signer) {
        owner = signer;
    }

    function approve(MockUSDG token, address escrow, uint256 amount) external {
        require(msg.sender == owner);
        token.approve(escrow, amount);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return bytes4(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(digest, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0);
    }
}

contract RentalEscrowRelayTest {
    RelayVm constant vm = RelayVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant TENANT_KEY = 0xA11CE;
    uint256 constant LANDLORD_KEY = 0xB0B;
    uint256 constant ARBITRATOR_KEY = 0xCAFE;
    address constant SPONSOR = address(0x900);
    MockUSDG token;
    MockMorphoVault vault;
    RentalEscrow escrow;
    address tenant;
    address landlord;
    address arbitrator;

    function setUp() public {
        tenant = vm.addr(TENANT_KEY);
        landlord = vm.addr(LANDLORD_KEY);
        arbitrator = vm.addr(ARBITRATOR_KEY);
        token = new MockUSDG();
        vault = new MockMorphoVault(address(token));
        escrow = _deploy(tenant);
        token.mint(tenant, 3_000e6);
        vm.prank(tenant);
        token.approve(address(escrow), 3_000e6);
    }

    function _deploy(address account) private returns (RentalEscrow) {
        return new RentalEscrow(
            RentalEscrow.Config(
                address(token),
                address(vault),
                account,
                landlord,
                arbitrator,
                account,
                3_000e6,
                0,
                true,
                keccak256("RELAY TEST AGREEMENT")
            )
        );
    }

    function _action(address signer, uint8 kind, uint256 amount, uint256 limit, uint256 nonce)
        private
        view
        returns (RentalEscrow.EscrowAction memory)
    {
        return RentalEscrow.EscrowAction(
            signer,
            kind,
            amount,
            limit,
            kind == 4 ? keccak256("PRIVATE EVIDENCE HASH") : bytes32(0),
            nonce,
            block.timestamp + 300
        );
    }

    function _signature(RentalEscrow.EscrowAction memory action, uint256 key) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, escrow.actionDigest(action));
        return abi.encodePacked(r, s, v);
    }

    function _relay(address signer, uint256 key, uint8 kind, uint256 amount, uint256 limit) private {
        RentalEscrow.EscrowAction memory action = _action(signer, kind, amount, limit, escrow.nonce());
        bytes memory signature = _signature(action, key);
        vm.prank(SPONSOR);
        escrow.executeSigned(action, signature);
    }

    function _fundAndSupply() private {
        _relay(tenant, TENANT_KEY, 0, 0, 0);
        _relay(landlord, LANDLORD_KEY, 0, 0, 0);
        _relay(tenant, TENANT_KEY, 1, 0, 0);
        _relay(tenant, TENANT_KEY, 2, 3_000e6, 3_000e18);
    }

    function testSponsorRelaysFullFlowWithoutSpendingAuthority() public {
        _fundAndSupply();
        token.mint(address(vault), 10e6);
        _relay(tenant, TENANT_KEY, 3, 10e6, 10e18);
        require(token.balanceOf(tenant) == 10e6 && escrow.securityValue() == 3_000e6);
        _relay(landlord, LANDLORD_KEY, 4, 120e6, 0);
        _relay(tenant, TENANT_KEY, 5, 0, 3_000e6);
        _relay(tenant, TENANT_KEY, 8, 0, 3_000e6);
        require(token.balanceOf(tenant) == 2_890e6 && token.balanceOf(landlord) == 120e6);
        require(token.balanceOf(SPONSOR) == 0 && escrow.nonce() == 8);
    }

    function testSignatureCannotChangeAmountActionSignerOrDeadline() public {
        _fundAndSupply();
        token.mint(address(vault), 10e6);
        RentalEscrow.EscrowAction memory action = _action(tenant, 3, 10e6, 10e18, 4);
        bytes memory signature = _signature(action, TENANT_KEY);
        action.amount = 9e6;
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, signature);
        action.amount = 10e6;
        action.deadline += 1;
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, signature);
        action.deadline -= 1;
        action.signer = landlord;
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, signature);
        action.signer = tenant;
        action.kind = 2;
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, signature);
    }

    function testSponsorCannotReplaceTenantSignatureOrBypassRoles() public {
        RentalEscrow.EscrowAction memory action = _action(tenant, 0, 0, 0, 0);
        bytes memory signature = _signature(action, LANDLORD_KEY);
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, signature);
        action.signer = arbitrator;
        signature = _signature(action, ARBITRATOR_KEY);
        vm.expectRevert(RentalEscrow.Unauthorized.selector);
        escrow.executeSigned(action, signature);
    }

    function testSignedOperationReplayAndCrossEscrowFail() public {
        RentalEscrow.EscrowAction memory action = _action(tenant, 0, 0, 0, 0);
        bytes memory signature = _signature(action, TENANT_KEY);
        RentalEscrow other = _deploy(tenant);
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        other.executeSigned(action, signature);
        escrow.executeSigned(action, signature);
        vm.expectRevert(RentalEscrow.StaleNonce.selector);
        escrow.executeSigned(action, signature);
    }

    function testSignedOperationExpiryWrongChainAndUnusedFieldsFail() public {
        RentalEscrow.EscrowAction memory action = _action(tenant, 0, 0, 0, 0);
        bytes memory signature = _signature(action, TENANT_KEY);
        action.amount = 1;
        vm.expectRevert(RentalEscrow.InvalidConfiguration.selector);
        escrow.executeSigned(action, signature);
        action.amount = 0;
        vm.warp(action.deadline + 1);
        vm.expectRevert(RentalEscrow.Expired.selector);
        escrow.executeSigned(action, signature);
        vm.chainId(46630);
        vm.expectRevert(RentalEscrow.WrongChain.selector);
        escrow.executeSigned(action, signature);
    }

    function testHighSMalformedAndInvalidVSignaturesFail() public {
        RentalEscrow.EscrowAction memory action = _action(tenant, 0, 0, 0, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TENANT_KEY, escrow.actionDigest(action));
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, highS);
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, abi.encodePacked(r, s, uint8(1)));
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, hex"1234");
    }

    function testERC1271ContractRoleWalletCanAuthorizeBoundedActions() public {
        Fixture1271Wallet wallet = new Fixture1271Wallet(tenant);
        escrow = _deploy(address(wallet));
        token.mint(address(wallet), 3_000e6);
        vm.prank(tenant);
        wallet.approve(token, address(escrow), 3_000e6);
        _relay(address(wallet), TENANT_KEY, 0, 0, 0);
        _relay(landlord, LANDLORD_KEY, 0, 0, 0);
        _relay(address(wallet), TENANT_KEY, 1, 0, 0);
        require(escrow.securityValue() == 3_000e6);
        RentalEscrow.EscrowAction memory action = _action(address(wallet), 2, 3_000e6, 3_000e18, 3);
        bytes memory signature = _signature(action, LANDLORD_KEY);
        vm.expectRevert(RentalEscrow.InvalidSignature.selector);
        escrow.executeSigned(action, signature);
    }

    function testRelayReentrancyAndFailedExecutionDoNotConsumeAuthorization() public {
        _fundAndSupply();
        token.mint(address(vault), 10e6);
        RentalEscrow.EscrowAction memory action = _action(tenant, 3, 10e6, 10e18, 4);
        bytes memory signature = _signature(action, TENANT_KEY);
        vault.setReentry(address(escrow), abi.encodeCall(escrow.executeSigned, (action, signature)));
        escrow.executeSigned(action, signature);
        require(!vault.reentrySuccess() && bytes4(vault.reentryResult()) == RentalEscrow.Reentrancy.selector);
        action = _action(tenant, 3, 1e6, 1e18, 5);
        signature = _signature(action, TENANT_KEY);
        vm.expectRevert(RentalEscrow.InvalidAmount.selector);
        escrow.executeSigned(action, signature);
        require(escrow.nonce() == 5);
    }
}
