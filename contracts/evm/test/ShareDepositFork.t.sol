// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ShareDeposit} from "../src/ShareDeposit.sol";
import {ShareDepositFactory} from "../src/ShareDepositFactory.sol";
import {IERC20Asset} from "../src/MorphoAdapter.sol";
import {IPriceOracle} from "../src/CollateralEscrow.sol";
import {DeployShareDeposit, ShareIssuer} from "../script/ShareDeposit.s.sol";
interface ShareForkVm {
    function envOr(string calldata,bool) external returns(bool);
    function envOr(string calldata,string calldata) external returns(string memory);
    function createSelectFork(string calldata) external returns(uint256);
    function skip(bool) external; function prank(address) external;
    function record() external; function accesses(address) external returns(bytes32[] memory,bytes32[] memory);
    function load(address,bytes32) external returns(bytes32); function store(address,bytes32,bytes32) external;
    function warp(uint256) external;
    function expectRevert() external;
    function etch(address,bytes calldata) external;
    function mockCall(address,bytes calldata,bytes calldata) external;
    function clearMockedCalls() external;
}
/// @notice Public RPC reads only. Synthetic balances and transactions exist solely in the local fork.
contract ShareDepositForkTest {
    ShareForkVm constant vm=ShareForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant STOCK=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant FEED=0x5196C8713A529bd676B875fB9Cea3F8a47ba48Be;
    address constant TENANT=address(0xA11CE);address constant LANDLORD=address(0xB0B);
    ShareDeposit escrow;
    function setUp() public {
        vm.skip(!vm.envOr("SHARE_DEPOSIT_FORK_PROOF",false));
        vm.createSelectFork(vm.envOr("SHARE_DEPOSIT_FORK_RPC","https://rpc.testnet.chain.robinhood.com"));
        require(block.chainid==46630,"WRONG_CHAIN");
        (uint256 p,uint256 time)=IPriceOracle(FEED).latestPrice();require(p>0 && time>0,"UNUSABLE_MIRROR");
        // Exercise a fresh round even if the public updater is currently stale. Not hosted evidence.
        vm.warp(time);
        ShareDepositFactory factory=new ShareDepositFactory(STOCK,FEED);
        vm.prank(LANDLORD);
        escrow=factory.create(ShareDeposit.Terms(TENANT,LANDLORD,address(0xCAFE),100e6,keccak256("LOCAL SHARE FORK"),2 days,7 days,14 days));
        uint256 amount=(150e6*1e18+p-1)/p;
        _fixture(TENANT,amount);
        vm.prank(TENANT);IERC20Asset(STOCK).approve(address(escrow),amount);
        vm.prank(TENANT);escrow.pledge(amount);
    }
    function testRealTokenInKindRoundTrip() public {
        uint256 balance=IERC20Asset(STOCK).balanceOf(address(escrow));require(escrow.state()==ShareDeposit.State.Active);
        uint256 landlordBefore=IERC20Asset(STOCK).balanceOf(LANDLORD);uint256 tenantBefore=IERC20Asset(STOCK).balanceOf(TENANT);
        vm.prank(LANDLORD);escrow.proposeClaim(12e6,keccak256("FORK EVIDENCE"));uint256 shares=escrow.claim().shares;
        vm.prank(TENANT);escrow.acceptClaim(shares);escrow.payout(false);escrow.payout(true);
        require(IERC20Asset(STOCK).balanceOf(LANDLORD)-landlordBefore==shares,"LANDLORD_DELTA");
        require(IERC20Asset(STOCK).balanceOf(TENANT)-tenantBefore==balance-shares,"TENANT_DELTA");
        require(IERC20Asset(STOCK).balanceOf(address(escrow))==0,"CUSTODY_REMAINS");
    }
    function testDeploymentPreflightRejectsDependencyMutations() public {
        DeployShareDeposit deploy=new DeployShareDeposit();deploy.verifyDependencies();
        bytes32 beaconSlot=0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
        bytes32 original=vm.load(STOCK,beaconSlot);vm.store(STOCK,beaconSlot,bytes32(uint256(1)));
        vm.expectRevert();deploy.verifyDependencies();vm.store(STOCK,beaconSlot,original);
        vm.mockCall(STOCK,abi.encodeCall(ShareIssuer.paused,()),abi.encode(true));
        vm.expectRevert();deploy.verifyDependencies();vm.clearMockedCalls();
        vm.mockCall(STOCK,abi.encodeCall(ShareIssuer.uiMultiplier,()),abi.encode(uint256(2e18)));
        vm.expectRevert();deploy.verifyDependencies();vm.clearMockedCalls();
        vm.mockCall(STOCK,abi.encodeCall(ShareIssuer.DOMAIN_SEPARATOR,()),abi.encode(bytes32(0)));
        vm.expectRevert();deploy.verifyDependencies();vm.clearMockedCalls();
        vm.mockCall(STOCK,abi.encodeCall(ShareIssuer.decimals,()),abi.encode(uint8(6)));
        vm.expectRevert();deploy.verifyDependencies();vm.clearMockedCalls();
        vm.etch(FEED,hex"00");vm.expectRevert();deploy.verifyDependencies();
    }
    function _fixture(address account,uint256 amount) private {
        vm.record();IERC20Asset(STOCK).balanceOf(account);(bytes32[] memory reads,)=vm.accesses(STOCK);
        for(uint256 i;i<reads.length;++i) {
            if(reads[i]==0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) continue;
            bytes32 old=vm.load(STOCK,reads[i]);vm.store(STOCK,reads[i],bytes32(amount));
            (bool ok,bytes memory result)=STOCK.staticcall(abi.encodeCall(IERC20Asset.balanceOf,(account)));
            if(ok && result.length==32 && abi.decode(result,(uint256))==amount) return;
            vm.store(STOCK,reads[i],old);
        }
        revert("BALANCE_SLOT_NOT_FOUND");
    }
}
