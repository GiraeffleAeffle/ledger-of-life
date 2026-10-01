// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ShareDeposit} from "../src/ShareDeposit.sol";
import {ShareDepositFactory} from "../src/ShareDepositFactory.sol";
import {MirroredPriceFeed} from "../src/testnet/MirroredPriceFeed.sol";

interface ShareVm {
    function prank(address) external; function expectRevert() external; function warp(uint256) external;
    function chainId(uint256) external; function addr(uint256) external returns(address);
    function sign(uint256, bytes32) external returns(uint8,bytes32,bytes32);
}
contract DepositStock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    mapping(address => bool) public blocked;
    uint256 public uiMultiplier = 1e18;
    bool public fee; address public callback;
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    function DOMAIN_SEPARATOR() public view returns(bytes32) { return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256("Tesla"),keccak256("1"),block.chainid,address(this))); }
    function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s) external {
        require(block.timestamp <= deadline);
        bytes32 digest = keccak256(abi.encodePacked(hex"1901",DOMAIN_SEPARATOR(),keccak256(abi.encode(PERMIT_TYPEHASH,owner,spender,value,nonces[owner]++,deadline))));
        require(ecrecover(digest,v,r,s)==owner && owner != address(0)); allowance[owner][spender]=value;
    }
    function mint(address a,uint256 n) external { balanceOf[a]+=n; }
    function burn(address a,uint256 n) external { balanceOf[a]-=n; }
    function blockRecipient(address a) external { blocked[a]=true; }
    function setMultiplier(uint256 n) external { uiMultiplier=n; }
    function setFee() external { fee=true; }
    function setCallback(address a) external { callback=a; }
    function approve(address a,uint256 n) external returns(bool) { allowance[msg.sender][a]=n; return true; }
    function transfer(address a,uint256 n) external returns(bool) { _transfer(msg.sender,a,n); return true; }
    function transferFrom(address a,address b,uint256 n) external returns(bool) { allowance[a][msg.sender]-=n; _transfer(a,b,n); return true; }
    function _transfer(address a,address b,uint256 n) private {
        require(!blocked[b]); balanceOf[a]-=n; balanceOf[b]+=fee ? n-1 : n;
        if(callback!=address(0)) { (bool ok,)=callback.call(abi.encodeCall(ShareDeposit.payout,(false))); require(ok,"REENTER_FAILED"); }
    }
}
contract DepositOracle {
    uint256 public p=400e6; uint256 public t; bool public fail;
    constructor() { t=block.timestamp; }
    function set(uint256 price,uint256 time) external { p=price;t=time; }
    function setFail() external { fail=true; }
    function latestPrice() external view returns(uint256,uint256) { require(!fail);return(p,t); }
}
contract ShareDepositTest {
    ShareVm constant vm=ShareVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address tenant; address constant landlord=address(0xB0B); address constant arb=address(0xCAFE);
    DepositStock stock; DepositOracle oracle; ShareDepositFactory factory; ShareDeposit escrow;
    function terms() private view returns(ShareDeposit.Terms memory) { return ShareDeposit.Terms(tenant,landlord,arb,1000e6,keccak256("agreement"),2 days,7 days,14 days); }
    function setUp() public {
        vm.chainId(31337);vm.warp(1_800_000_000);tenant=vm.addr(123);
        stock=new DepositStock();oracle=new DepositOracle();factory=new ShareDepositFactory(address(stock),address(oracle));
        ShareDeposit.Terms memory t=terms();vm.prank(landlord);escrow=factory.create(t);
        stock.mint(tenant,20e18);vm.prank(tenant);stock.approve(address(escrow),type(uint256).max);
    }
    function pledge(uint256 n) private { vm.prank(tenant);escrow.pledge(n); }
    function claim(uint256 usd) private { vm.prank(landlord);escrow.proposeClaim(usd,keccak256("evidence")); }
    function testRatioBoundaryAndWithdraw() public {
        pledge(375e16-1);require(escrow.state()==ShareDeposit.State.AwaitingLock);
        vm.expectRevert();escrow.activate();pledge(1);require(escrow.state()==ShareDeposit.State.Active && escrow.coverBps()==15000);
        vm.expectRevert();vm.prank(tenant);escrow.withdraw(1);
        pledge(1e18);vm.prank(tenant);escrow.withdraw(1e18);require(stock.balanceOf(address(escrow))==375e16);
    }
    function testAwaitingCanWithdrawWithoutPrice() public {
        pledge(1e18);oracle.set(0,0);vm.prank(tenant);escrow.withdraw(1e18);require(stock.balanceOf(address(escrow))==0);
    }
    function testStaleTopUpAndPriceFreeDecisions() public {
        pledge(4e18);oracle.set(400e6,block.timestamp-75 hours);pledge(1e18);
        vm.expectRevert();vm.prank(tenant);escrow.withdraw(1);
        vm.expectRevert();claim(1e6);
        oracle.set(400e6,block.timestamp);claim(120e6);oracle.set(0,0);
        vm.prank(tenant);escrow.acceptClaim(3e17);escrow.payout(false);escrow.payout(true);
        require(stock.balanceOf(landlord)==3e17 && stock.balanceOf(address(escrow))==0);
    }
    function testFreshnessEdgesAndQuoteFailure() public {
        // Epoch Thursday + 2 days = Saturday; Monday noon ends the extended window.
        vm.warp(2 days+3000 weeks);oracle.set(400e6,block.timestamp-74 hours);
        (,,bool fresh)=escrow.quote();require(fresh && escrow.priceMaxAge()==74 hours);
        oracle.set(400e6,block.timestamp-74 hours-1);(,,fresh)=escrow.quote();require(!fresh);
        vm.warp(4 days+3000 weeks+12 hours);require(escrow.priceMaxAge()==26 hours);
        oracle.set(400e6,block.timestamp-26 hours);(,,fresh)=escrow.quote();require(fresh);
        oracle.set(400e6,block.timestamp-26 hours-1);(,,fresh)=escrow.quote();require(!fresh);
        oracle.set(400e6,block.timestamp+1);(,,fresh)=escrow.quote();require(!fresh);
        oracle.set(0,block.timestamp);(,,fresh)=escrow.quote();require(!fresh);
        oracle.setFail();(uint256 p,uint256 t,bool f)=escrow.quote();require(p==0 && t==0 && !f);
    }
    function testMultiplierMismatchAllowsTopUpNotActivation() public {
        MirroredPriceFeed feed=new MirroredPriceFeed(address(this),address(stock),address(1),4663,400e8);
        feed.push(1,400e8,block.timestamp,1e18);
        ShareDepositFactory f=new ShareDepositFactory(address(stock),address(feed));
        ShareDeposit.Terms memory t=terms();vm.prank(landlord);ShareDeposit e=f.create(t);
        vm.prank(tenant);stock.approve(address(e),10e18);stock.setMultiplier(2e18);
        vm.prank(tenant);e.pledge(4e18);require(e.state()==ShareDeposit.State.AwaitingLock);
        vm.expectRevert();e.activate();stock.setMultiplier(1e18);e.activate();require(e.state()==ShareDeposit.State.Active);
    }
    function testRoundingFrozenAndClaimBounds() public {
        pledge(4e18);oracle.set(333e6,block.timestamp);claim(1);
        ShareDeposit.Claim memory c=escrow.claim();require(c.shares==3003003004 && c.price6==333e6 && c.usd6==1);
        vm.expectRevert();vm.prank(tenant);escrow.acceptClaim(c.shares-1);
        vm.prank(tenant);escrow.contestClaim();
        oracle.set(0,0);vm.prank(arb);escrow.resolveClaim(c.shares+1);escrow.payout(true);require(stock.balanceOf(landlord)==c.shares);
    }
    function testZeroClaimDonationAndIndependentBlockedPayout() public {
        pledge(4e18);claim(120e6);vm.prank(tenant);escrow.acceptClaim(3e17);
        stock.blockRecipient(landlord);vm.expectRevert();escrow.payout(true);
        escrow.payout(false);require(stock.balanceOf(address(escrow))==3e17 && escrow.landlordOwed()==3e17);
        stock.mint(address(escrow),1e18);escrow.payout(false);require(stock.balanceOf(address(escrow))==3e17);
    }
    function testZeroClaimWithoutPrice() public {
        pledge(4e18);oracle.set(0,0);claim(0);escrow.payout(false);require(stock.balanceOf(tenant)==20e18 && escrow.state()==ShareDeposit.State.Closed);
    }
    function testBurnCapsClaimAndPayout() public {
        pledge(4e18);stock.burn(address(escrow),3e18);require(escrow.custodyShortfall());claim(1000e6);
        require(escrow.claim().shares==1e18);vm.prank(tenant);escrow.acceptClaim(1e18);
        stock.burn(address(escrow),5e17);escrow.payout(false);escrow.payout(true);
        require(stock.balanceOf(landlord)==5e17 && stock.balanceOf(address(escrow))==0);
    }
    function testPermitFrontRunSurvives() public {
        uint256 deadline=block.timestamp+100;
        bytes32 digest=keccak256(abi.encodePacked(hex"1901",stock.DOMAIN_SEPARATOR(),keccak256(abi.encode(stock.PERMIT_TYPEHASH(),tenant,address(escrow),4e18,0,deadline))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(123,digest);
        stock.permit(tenant,address(escrow),4e18,deadline,v,r,s);
        escrow.pledgeWithPermit(4e18,deadline,v,r,s);require(escrow.state()==ShareDeposit.State.Active && stock.nonces(tenant)==1);
    }
    function testFactoryDeterminismDuplicateAndSelfLock() public {
        ShareDeposit.Terms memory t=terms();require(factory.predict(t)==address(escrow));
        vm.expectRevert();vm.prank(landlord);factory.create(t);vm.expectRevert();escrow.initialize(t);
        ShareDeposit implementation=factory.implementation();
        vm.expectRevert();vm.prank(address(factory));implementation.initialize(t);
        t.agreementHash=keccak256("another");address predicted=factory.predict(t);vm.prank(landlord);require(address(factory.create(t))==predicted);
        t.tenant=landlord;t.agreementHash=keccak256("invalid");vm.expectRevert();vm.prank(landlord);factory.create(t);
    }
    function testFactoryLandlordNamespacePreventsPreemption() public {
        ShareDeposit.Terms memory t=terms();t.agreementHash=keccak256("unoccupied");
        vm.expectRevert();factory.create(t);
        require(factory.escrowFor(landlord,t.agreementHash)==address(0));
        address attacker=address(0xBAD);t.landlord=attacker;
        vm.prank(attacker);ShareDeposit other=factory.create(t);
        require(factory.escrowFor(landlord,t.agreementHash)==address(0));
        t.landlord=landlord;vm.prank(landlord);ShareDeposit intended=factory.create(t);
        require(address(intended)!=address(other) && factory.escrowFor(landlord,t.agreementHash)==address(intended));
        t.depositValue=500e6;vm.expectRevert();vm.prank(landlord);factory.create(t);
    }
    function testInvalidPermitCannotConsumeLargerOrSplitAllowance() public {
        vm.expectRevert();escrow.pledgeWithPermit(1e18,block.timestamp+100,27,bytes32(0),bytes32(0));
        uint256 deadline=block.timestamp+100;
        bytes32 digest=keccak256(abi.encodePacked(hex"1901",stock.DOMAIN_SEPARATOR(),keccak256(abi.encode(stock.PERMIT_TYPEHASH(),tenant,address(escrow),4e18,0,deadline))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(123,digest);
        stock.permit(tenant,address(escrow),4e18,deadline,v,r,s);
        vm.expectRevert();escrow.pledgeWithPermit(1e18,deadline,v,r,s);
        require(stock.balanceOf(address(escrow))==0 && stock.allowance(tenant,address(escrow))==4e18);
        escrow.pledgeWithPermit(4e18,deadline,v,r,s);
        require(stock.allowance(tenant,address(escrow))==0 && stock.balanceOf(address(escrow))==4e18);
    }
    function testDonationWithdrawalPreservesBurnDetection() public {
        pledge(4e18);stock.mint(address(escrow),10e18);vm.prank(tenant);escrow.withdraw(10e18);
        require(escrow.trackedBalance()==4e18 && !escrow.custodyShortfall());
        stock.burn(address(escrow),1e18);require(escrow.custodyShortfall());
    }
    function testWindowsBoundAndBindCreate2Terms() public {
        ShareDeposit.Terms memory t=terms();t.agreementHash=keccak256("windows");
        address original=factory.predict(t);t.responseWindow+=1;require(factory.predict(t)!=original);
        t.responseWindow=1 hours-1;vm.expectRevert();vm.prank(landlord);factory.create(t);
        t.responseWindow=400 days+1;vm.expectRevert();vm.prank(landlord);factory.create(t);
        t.responseWindow=1 hours;t.returnWindow=1 hours-1;vm.expectRevert();vm.prank(landlord);factory.create(t);
        t.returnWindow=400 days+1;vm.expectRevert();vm.prank(landlord);factory.create(t);
        t.returnWindow=400 days;t.arbitrationWindow=1 hours-1;vm.expectRevert();vm.prank(landlord);factory.create(t);
        t.arbitrationWindow=400 days+1;vm.expectRevert();vm.prank(landlord);factory.create(t);
        t.arbitrationWindow=400 days;vm.prank(landlord);ShareDeposit e=factory.create(t);
        require(e.responseWindow()==1 hours && e.returnWindow()==400 days && e.arbitrationWindow()==400 days);
    }
    function testSilentResponseEscalatesNeverApproves() public {
        pledge(4e18);claim(120e6);uint256 deadline=escrow.responseDeadline();
        vm.warp(deadline-1);vm.expectRevert();escrow.escalateClaim();
        vm.warp(deadline);escrow.escalateClaim();
        require(escrow.state()==ShareDeposit.State.ClaimContested && escrow.landlordOwed()==0);
        vm.expectRevert();vm.prank(tenant);escrow.acceptClaim(3e17);vm.expectRevert();escrow.escalateClaim();
        vm.prank(arb);escrow.resolveClaim(1e17);escrow.payout(true);require(stock.balanceOf(landlord)==1e17);
    }
    function testPendingAndContestedLoweringIsPriceFreeAndTenantRounded() public {
        pledge(4e18);oracle.set(333e6,block.timestamp);claim(120e6);
        vm.expectRevert();escrow.lowerClaim(100e6);
        vm.expectRevert();vm.prank(landlord);escrow.lowerClaim(120e6);
        vm.expectRevert();vm.prank(landlord);escrow.lowerClaim(121e6);
        vm.prank(tenant);escrow.contestClaim();oracle.set(0,0);
        uint256 originalDeadline=escrow.responseDeadline();vm.warp(block.timestamp+1 hours);
        vm.prank(landlord);escrow.lowerClaim(1);
        require(escrow.claim().shares==3003003003 && escrow.claim().price6==333e6
            && escrow.state()==ShareDeposit.State.ClaimPending && escrow.responseDeadline()==originalDeadline);
        vm.prank(tenant);escrow.acceptClaim(3003003003);
        vm.expectRevert();vm.prank(landlord);escrow.lowerClaim(0);
    }
    function testLandlordCanWithdrawPendingOrContestedClaim() public {
        pledge(4e18);claim(120e6);vm.prank(landlord);escrow.lowerClaim(100e6);require(escrow.claim().shares==25e16);
        vm.prank(tenant);escrow.contestClaim();oracle.set(0,0);
        vm.prank(landlord);escrow.lowerClaim(0);escrow.payout(false);require(stock.balanceOf(tenant)==20e18);
    }
    function testPendingClaimCanBeWithdrawnWithoutPrice() public {
        pledge(4e18);claim(120e6);oracle.set(0,0);
        vm.prank(landlord);escrow.lowerClaim(0);
        require(escrow.state()==ShareDeposit.State.Closed && escrow.responseDeadline()==0 && escrow.claim().shares==0);
        escrow.payout(false);require(stock.balanceOf(tenant)==20e18);
    }
    function testLoweredExhaustedClaimCannotIncreaseShares() public {
        pledge(4e18);stock.burn(address(escrow),3e18);claim(1000e6);
        vm.prank(landlord);escrow.lowerClaim(900e6);require(escrow.claim().shares==1e18);
        vm.prank(tenant);escrow.contestClaim();
        vm.prank(arb);escrow.resolveClaim(1e18+1);require(escrow.landlordOwed()==1e18);
    }
    function testLoweringCannotRevokeArbitrationOrResetItsDeadline() public {
        pledge(4e18);claim(120e6);vm.expectRevert();vm.prank(arb);escrow.resolveClaim(3e17);
        vm.prank(tenant);escrow.contestClaim();
        uint256 started=escrow.arbitrationStartedAt();uint256 response=escrow.responseDeadline();
        vm.warp(block.timestamp+1 hours);vm.prank(landlord);escrow.lowerClaim(120e6-1);
        require(escrow.arbitrationAuthorized() && escrow.arbitrationStartedAt()==started && escrow.responseDeadline()==response);
        vm.prank(arb);escrow.resolveClaim(3e17);
        require(escrow.landlordOwed()==(120e6-1)*1e18/400e6 && !escrow.arbitrationAuthorized());
    }
    function testTenantAcceptanceBoundSurvivesConcurrentLowering() public {
        pledge(4e18);claim(120e6);vm.prank(landlord);escrow.lowerClaim(100e6);
        vm.prank(tenant);escrow.acceptClaim(3e17);require(escrow.landlordOwed()==25e16);
    }
    function testArbitrationTimeoutReturnsFullDepositAndStopsLateDecisions() public {
        pledge(4e18);vm.expectRevert();escrow.closeUnresolved();
        claim(120e6);vm.expectRevert();escrow.closeUnresolved();
        vm.prank(tenant);escrow.contestClaim();uint256 deadline=escrow.arbitrationStartedAt()+escrow.arbitrationWindow();
        vm.warp(deadline-1);vm.expectRevert();escrow.closeUnresolved();
        vm.prank(landlord);escrow.lowerClaim(100e6);vm.prank(tenant);escrow.contestClaim();
        require(escrow.arbitrationStartedAt()+escrow.arbitrationWindow()==deadline);
        vm.prank(landlord);escrow.lowerClaim(99e6);vm.warp(deadline);
        vm.expectRevert();vm.prank(arb);escrow.resolveClaim(1);
        vm.expectRevert();vm.prank(tenant);escrow.acceptClaim(3e17);
        oracle.set(0,0);escrow.closeUnresolved();escrow.payout(false);
        require(stock.balanceOf(tenant)==20e18 && escrow.landlordOwed()==0);
        vm.expectRevert();escrow.closeUnresolved();
    }
    function testEveryNonClosedStateHasAnEventualPriceFreeExit() public {
        for(uint256 i;i<5;++i) {
            ShareDeposit.Terms memory t=terms();t.agreementHash=keccak256(abi.encode("EXIT",i));
            vm.prank(landlord);ShareDeposit e=factory.create(t);oracle.set(400e6,block.timestamp);
            vm.prank(tenant);stock.approve(address(e),4e18);
            vm.prank(tenant);e.pledge(i==0 ? 1e18 : 4e18);
            if(i==0) { oracle.set(0,0);vm.prank(tenant);e.withdraw(1e18); }
            else if(i==1) {
                vm.prank(tenant);e.requestReturn();vm.warp(e.returnDeadline());oracle.set(0,0);e.closeUnclaimed();e.payout(false);
            } else {
                vm.prank(landlord);e.proposeClaim(120e6,bytes32(0));
                if(i==2) { vm.warp(e.responseDeadline());e.escalateClaim(); }
                else { vm.prank(tenant);e.contestClaim(); }
                if(i==4) { vm.prank(landlord);e.lowerClaim(119e6); }
                vm.warp(e.arbitrationStartedAt()+e.arbitrationWindow());oracle.set(0,0);e.closeUnresolved();e.payout(false);
            }
            require(stock.balanceOf(address(e))==0 && stock.balanceOf(tenant)==20e18,"NO_PERMANENT_LOCK");
        }
    }
    function testUnsolicitedInflowsCanRefillUnpaidLandlordAfterBurn() public {
        pledge(4e18);claim(1000e6);vm.prank(tenant);escrow.acceptClaim(25e17);
        stock.burn(address(escrow),3e18);stock.mint(address(escrow),15e17);
        escrow.payout(false);require(stock.balanceOf(address(escrow))==25e17);
        escrow.payout(true);require(stock.balanceOf(landlord)==25e17);
    }
    function testReturnRequestRolesDeadlineAndNoPriceClose() public {
        vm.expectRevert();vm.prank(tenant);escrow.requestReturn();
        pledge(4e18);vm.expectRevert();escrow.requestReturn();
        vm.prank(tenant);escrow.requestReturn();uint256 deadline=escrow.returnDeadline();
        vm.expectRevert();vm.prank(tenant);escrow.requestReturn();
        oracle.set(0,0);vm.warp(deadline-1);vm.expectRevert();escrow.closeUnclaimed();
        vm.warp(deadline);vm.expectRevert();claim(0);
        escrow.closeUnclaimed();escrow.payout(false);require(stock.balanceOf(tenant)==20e18);
        vm.expectRevert();escrow.closeUnclaimed();
    }
    function testProposalInsideReturnWindowRetainsConsentRequirement() public {
        pledge(4e18);vm.prank(tenant);escrow.requestReturn();
        vm.warp(escrow.returnDeadline()-1);oracle.set(400e6,block.timestamp);claim(120e6);
        require(escrow.returnDeadline()==0 && escrow.state()==ShareDeposit.State.ClaimPending);
        vm.warp(block.timestamp+10 days);vm.expectRevert();escrow.closeUnclaimed();
        escrow.escalateClaim();vm.expectRevert();vm.prank(tenant);escrow.requestReturn();
        vm.prank(arb);escrow.resolveClaim(0);
    }
    function testRolesStatesAndChain() public {
        vm.expectRevert();escrow.pledge(1);pledge(4e18);
        vm.expectRevert();escrow.proposeClaim(1,bytes32(0));vm.expectRevert();claim(1000e6+1);claim(1e6);
        vm.expectRevert();escrow.acceptClaim(25e14);vm.expectRevert();escrow.contestClaim();vm.expectRevert();escrow.resolveClaim(0);
        vm.expectRevert();vm.prank(tenant);escrow.withdraw(1);vm.prank(tenant);escrow.contestClaim();
        vm.expectRevert();vm.prank(landlord);escrow.resolveClaim(0);vm.prank(arb);escrow.resolveClaim(0);
        vm.expectRevert();pledge(1);vm.chainId(1);vm.expectRevert();escrow.payout(false);
        vm.expectRevert();new ShareDepositFactory(address(stock),address(oracle));
    }
    function testTransferDeltaAndReentrancy() public {
        stock.setFee();vm.expectRevert();pledge(4e18);require(stock.balanceOf(address(escrow))==0);
    }
    function testReentrantPayoutRollsBack() public {
        pledge(4e18);claim(0);stock.setCallback(address(escrow));vm.expectRevert();escrow.payout(false);
        require(stock.balanceOf(address(escrow))==4e18);
    }
    function testFuzzConservation(uint96 raw) public {
        uint256 extra=uint256(raw)%1e18;pledge(4e18+extra);claim(120e6);vm.prank(tenant);escrow.acceptClaim(3e17);
        escrow.payout(false);escrow.payout(true);require(stock.balanceOf(tenant)+stock.balanceOf(landlord)==20e18);
    }
}
