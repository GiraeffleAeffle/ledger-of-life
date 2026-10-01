// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ShareDeposit} from "./ShareDeposit.sol";

/// @notice No administrator or upgrades. Landlord creation binds every term into CREATE2.
contract ShareDepositFactory {
    address public constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address public constant FEED = 0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be;
    ShareDeposit public immutable implementation;
    mapping(bytes32 => address) private escrows;
    error DuplicateAgreement(); error DeploymentFailed(); error InvalidDependencies();
    event Created(bytes32 indexed agreementHash, address indexed escrow, bytes32 indexed salt);
    constructor(address stock, address oracle) {
        if (block.chainid != 46630 && block.chainid != 31337) revert ShareDeposit.WrongChain();
        if (block.chainid == 46630 && (stock != TSLA || oracle != FEED)) revert InvalidDependencies();
        implementation = new ShareDeposit(address(this), stock, oracle);
    }
    function salt(ShareDeposit.Terms calldata terms) public pure returns (bytes32) { return keccak256(abi.encode(terms)); }
    function escrowFor(address landlord, bytes32 agreementHash) public view returns (address) {
        return escrows[keccak256(abi.encode(landlord, agreementHash))];
    }
    function _creationCode() private view returns (bytes memory) {
        return abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", address(implementation), hex"5af43d82803e903d91602b57fd5bf3");
    }
    function predict(ShareDeposit.Terms calldata terms) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt(terms), keccak256(_creationCode()))))));
    }
    function create(ShareDeposit.Terms calldata terms) external returns (ShareDeposit escrow) {
        if (msg.sender != terms.landlord) revert ShareDeposit.Unauthorized();
        if (escrowFor(terms.landlord, terms.agreementHash) != address(0)) revert DuplicateAgreement();
        bytes memory code = _creationCode(); bytes32 deploymentSalt = salt(terms); address clone;
        assembly { clone := create2(0, add(code, 32), mload(code), deploymentSalt) }
        if (clone == address(0)) revert DeploymentFailed();
        escrow = ShareDeposit(clone);
        escrow.initialize(terms);
        escrows[keccak256(abi.encode(terms.landlord, terms.agreementHash))] = clone;
        emit Created(terms.agreementHash, clone, deploymentSalt);
    }
}
