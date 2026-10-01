// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ShareDepositFactory} from "../src/ShareDepositFactory.sol";
interface ShareDeployVm {
    function startBroadcast() external; function stopBroadcast() external;
    function load(address,bytes32) external view returns(bytes32);
    function projectRoot() external view returns(string memory);
    function readFile(string calldata) external view returns(string memory);
    function parseJsonAddress(string calldata,string calldata) external pure returns(address);
    function parseJsonBytes32(string calldata,string calldata) external pure returns(bytes32);
    function parseJsonUint(string calldata,string calldata) external pure returns(uint256);
}
interface ShareIssuer {
    function implementation() external view returns(address);
    function ACCESS_CONTROLLED_REGISTRY() external view returns(address);
    function paused() external view returns(bool);
    function isBlocked(address) external view returns(bool);
    function decimals() external view returns(uint8);
    function uiMultiplier() external view returns(uint256);
    function DOMAIN_SEPARATOR() external view returns(bytes32);
    function eip712Domain() external view returns(bytes1,string memory,string memory,uint256,address,bytes32,uint256[] memory);
}
/// @notice Dry-run by default. Dependency verification precedes startBroadcast and fails closed.
contract DeployShareDeposit {
    ShareDeployVm constant vm=ShareDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant STOCK=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant FEED=0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be;
    bytes32 constant BEACON_SLOT=0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    event Deployment(uint256 chainId,address factory,address implementation,bytes32 factoryCodeHash,bytes32 implementationCodeHash,address stock,address feed);
    function verifyDependencies() public view {
        require(block.chainid==46630,"ROBINHOOD_TESTNET_ONLY");
        string memory root=vm.projectRoot();
        string memory shared=vm.readFile(string.concat(root,"/deployments/shared-market-46630.json"));
        string memory share=vm.readFile(string.concat(root,"/deployments/share-deposit-46630.json"));
        require(vm.parseJsonAddress(share,".stock")==STOCK && vm.parseJsonAddress(share,".oracle")==FEED,"ASSET_PINS");
        require(vm.parseJsonAddress(shared,".stock")==STOCK && vm.parseJsonAddress(shared,".oracle")==FEED,"SHARED_ASSET_PINS");
        _hash(STOCK,shared,share,".dependencyCodeHashes.stock",".codeHashes.stock");
        _hash(FEED,shared,share,".dependencyCodeHashes.oracle",".codeHashes.oracle");
        address beacon=_addressPin(shared,share,".collateralIssuer.beacon");
        address implementation=_addressPin(shared,share,".collateralIssuer.implementation");
        address registry=_addressPin(shared,share,".collateralIssuer.registry");
        require(address(uint160(uint256(vm.load(STOCK,BEACON_SLOT))))==beacon,"BEACON_CHANGED");
        require(ShareIssuer(beacon).implementation()==implementation,"ISSUER_IMPLEMENTATION_CHANGED");
        require(ShareIssuer(STOCK).ACCESS_CONTROLLED_REGISTRY()==registry,"REGISTRY_CHANGED");
        _hash(beacon,shared,share,".collateralIssuer.codeHashes.beacon",".collateralIssuer.codeHashes.beacon");
        _hash(implementation,shared,share,".collateralIssuer.codeHashes.implementation",".collateralIssuer.codeHashes.implementation");
        _hash(registry,shared,share,".collateralIssuer.codeHashes.registry",".collateralIssuer.codeHashes.registry");
        require(ShareIssuer(STOCK).decimals()==vm.parseJsonUint(share,".tokenIdentity.decimals"),"DECIMALS_CHANGED");
        require(ShareIssuer(STOCK).uiMultiplier()==vm.parseJsonUint(share,".tokenIdentity.multiplier"),"MULTIPLIER_CHANGED");
        require(!ShareIssuer(STOCK).paused(),"ISSUER_PAUSED");
        require(!ShareIssuer(registry).isBlocked(STOCK) && !ShareIssuer(registry).isBlocked(msg.sender),"ISSUER_BLOCKED");
        _permitDomain();
    }
    function _addressPin(string memory shared,string memory share,string memory path) private pure returns(address pin) {
        pin=vm.parseJsonAddress(shared,path);require(vm.parseJsonAddress(share,path)==pin,"MANIFEST_ADDRESS_MISMATCH");
    }
    function _hash(address target,string memory shared,string memory share,string memory sharePath,string memory sharedPath) private view {
        bytes32 pin=vm.parseJsonBytes32(shared,sharedPath);
        require(vm.parseJsonBytes32(share,sharePath)==pin && target.code.length!=0 && target.codehash==pin,"DEPENDENCY_CODE_CHANGED");
    }
    function _permitDomain() private view {
        (bytes1 fields,string memory name,string memory version,uint256 chainId,address verifyingContract,,uint256[] memory extensions)=ShareIssuer(STOCK).eip712Domain();
        require(fields==0x0f && keccak256(bytes(name))==keccak256("Tesla") && keccak256(bytes(version))==keccak256("1")
            && chainId==46630 && verifyingContract==STOCK && extensions.length==0,"PERMIT_DOMAIN_CHANGED");
        bytes32 domain=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256("Tesla"),keccak256("1"),uint256(46630),STOCK));
        require(ShareIssuer(STOCK).DOMAIN_SEPARATOR()==domain,"PERMIT_SEPARATOR_CHANGED");
    }
    function run() external returns(ShareDepositFactory factory) {
        verifyDependencies();
        vm.startBroadcast();factory=new ShareDepositFactory(STOCK,FEED);vm.stopBroadcast();
        address implementation=address(factory.implementation());
        emit Deployment(block.chainid,address(factory),implementation,address(factory).codehash,implementation.codehash,STOCK,FEED);
    }
}
