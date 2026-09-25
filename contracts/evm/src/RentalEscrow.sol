// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset, IMorphoVault, MorphoAdapter} from "./MorphoAdapter.sol";

/// @notice Immutable, per-tenancy security. It has no investment-wallet allowance or arbitrary executor.
/// @dev Production suitability and the external vault require independent review. No upgrade/admin key exists.
contract RentalEscrow {
    using MorphoAdapter for IERC20Asset;

    enum State {
        Agreement,
        AwaitingFunding,
        Active,
        ClaimPending,
        ClaimContested,
        ReadyToSettle,
        Closed
    }

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidState();
    error InvalidAmount();
    error StaleNonce();
    error Expired();
    error WrongChain();
    error Reentrancy();
    error ReleaseForbidden();
    error InsufficientSecurity();
    error SettlementBelowMinimum();
    error InvalidSignature();

    IERC20Asset public immutable asset;
    IMorphoVault public immutable vault;
    address public immutable tenant;
    address public immutable landlord;
    address public immutable arbitrator;
    address public immutable personalWallet;
    uint256 public immutable fixedChainId;
    uint256 public immutable securityRequirement;
    uint256 public immutable fundingReserve;
    bool public immutable earningsReleaseAllowed;
    bytes32 public immutable agreementHash;

    State public state;
    uint256 public nonce;
    bool public tenantAccepted;
    bool public landlordAccepted;
    uint256 public trackedShares;
    uint256 public totalSupplied;
    uint256 public totalRedeemed;
    uint256 public releasedEarnings;
    uint256 public claimAmount;
    bytes32 public claimEvidenceHash;
    uint256 public approvedLandlordAmount;
    uint256 public minimumSettlementAssets;
    uint256 public settledLandlordAmount;
    uint256 public settledTenantAmount;
    bool public arbitratedDecision;
    bool private entered;
    bool private relaying;
    address private relaySigner;
    bytes32 private constant ACTION_TYPEHASH = keccak256(
        "EscrowAction(address signer,uint8 kind,uint256 amount,uint256 limit,bytes32 evidence,uint256 expectedNonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event AgreementAccepted(address indexed party, uint256 indexed operationNonce);
    event Funded(uint256 assets, uint256 indexed operationNonce);
    event Supplied(uint256 assets, uint256 shares, uint256 indexed operationNonce);
    event EarningsReleased(address indexed tenantWallet, uint256 assets, uint256 indexed operationNonce);
    event ClaimProposed(uint256 assets, bytes32 evidenceHash, uint256 indexed operationNonce);
    event ClaimContested(uint256 indexed operationNonce);
    event SettlementApproved(
        address indexed decisionMaker, uint256 landlordAssets, uint256 minimumAssets, uint256 indexed operationNonce
    );
    event Settled(uint256 landlordAssets, uint256 tenantAssets, uint256 indexed operationNonce);
    event DonationReturned(uint256 assets, uint256 indexed operationNonce);
    event SignedOperationExecuted(address indexed signer, bytes32 indexed digest, uint256 indexed operationNonce);

    struct EscrowAction {
        address signer;
        uint8 kind;
        uint256 amount;
        uint256 limit;
        bytes32 evidence;
        uint256 expectedNonce;
        uint256 deadline;
    }

    struct Config {
        address asset;
        address vault;
        address tenant;
        address landlord;
        address arbitrator;
        address personalWallet;
        uint256 securityRequirement;
        uint256 fundingReserve;
        bool earningsReleaseAllowed;
        bytes32 agreementHash;
    }

    constructor(Config memory config) {
        if (
            config.asset.code.length == 0 || config.vault.code.length == 0 || config.tenant == address(0)
                || config.landlord == address(0) || config.arbitrator == address(0)
                || config.personalWallet == address(0) || config.tenant == config.landlord
                || config.tenant == config.arbitrator || config.landlord == config.arbitrator
                || config.personalWallet == config.landlord || config.personalWallet == config.arbitrator
                || config.securityRequirement == 0 || config.fundingReserve > 1e6
                || config.fundingReserve > config.securityRequirement / 100 || config.agreementHash == bytes32(0)
        ) revert InvalidConfiguration();
        if (IMorphoVault(config.vault).asset() != config.asset) revert InvalidConfiguration();
        asset = IERC20Asset(config.asset);
        vault = IMorphoVault(config.vault);
        tenant = config.tenant;
        fundingReserve = config.fundingReserve;
        landlord = config.landlord;
        arbitrator = config.arbitrator;
        personalWallet = config.personalWallet;
        securityRequirement = config.securityRequirement;
        earningsReleaseAllowed = config.earningsReleaseAllowed;
        agreementHash = config.agreementHash;
        fixedChainId = block.chainid;
    }

    modifier operation(uint256 expectedNonce, uint256 deadline) {
        if (entered) revert Reentrancy();
        if (block.chainid != fixedChainId) revert WrongChain();
        if (expectedNonce != nonce) revert StaleNonce();
        if (block.timestamp > deadline) revert Expired();
        entered = true;
        nonce = expectedNonce + 1;
        _;
        entered = false;
    }

    /// @notice Sponsor pays gas for a signed, enumerated rental action. There is no arbitrary-call payload.
    function executeSigned(EscrowAction calldata action, bytes calldata signature) external {
        if (entered || relaying) revert Reentrancy();
        if (block.chainid != fixedChainId) revert WrongChain();
        if (action.expectedNonce != nonce) revert StaleNonce();
        if (block.timestamp > action.deadline) revert Expired();
        _validateActionFields(action);
        bytes32 digest = actionDigest(action);
        if (!_validSignature(action.signer, digest, signature)) revert InvalidSignature();
        relaying = true;
        relaySigner = action.signer;
        if (action.kind == 0) {
            this.acceptAgreement(action.expectedNonce, action.deadline);
        } else if (action.kind == 1) {
            this.fund(action.expectedNonce, action.deadline);
        } else if (action.kind == 2) {
            this.supply(action.amount, action.limit, action.expectedNonce, action.deadline);
        } else if (action.kind == 3) {
            this.releaseEarnings(action.amount, action.limit, action.expectedNonce, action.deadline);
        } else if (action.kind == 4) {
            this.proposeClaim(action.amount, action.evidence, action.expectedNonce, action.deadline);
        } else if (action.kind == 5) {
            this.acceptClaim(action.limit, action.expectedNonce, action.deadline);
        } else if (action.kind == 6) {
            this.contestClaim(action.expectedNonce, action.deadline);
        } else if (action.kind == 7) {
            this.resolveClaim(action.amount, action.limit, action.expectedNonce, action.deadline);
        } else {
            this.settle(action.limit, action.expectedNonce, action.deadline);
        }
        relaySigner = address(0);
        relaying = false;
        emit SignedOperationExecuted(action.signer, digest, action.expectedNonce);
    }

    function actionDigest(EscrowAction calldata action) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("RentalEscrow"), keccak256("1"), fixedChainId, address(this))
        );
        bytes32 value = keccak256(
            abi.encode(
                ACTION_TYPEHASH,
                action.signer,
                action.kind,
                action.amount,
                action.limit,
                action.evidence,
                action.expectedNonce,
                action.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, value));
    }

    function _validateActionFields(EscrowAction calldata action) private pure {
        if (action.kind > 8 || action.signer == address(0)) revert InvalidConfiguration();
        if (action.kind != 4 && action.evidence != bytes32(0)) revert InvalidConfiguration();
        if (
            (action.kind == 0 || action.kind == 1 || action.kind == 5 || action.kind == 6 || action.kind == 8)
                && action.amount != 0
        ) revert InvalidConfiguration();
        if ((action.kind == 0 || action.kind == 1 || action.kind == 4 || action.kind == 6) && action.limit != 0) {
            revert InvalidConfiguration();
        }
    }

    function _validSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length != 0) {
            (bool success, bytes memory result) =
                signer.staticcall(abi.encodeWithSelector(bytes4(0x1626ba7e), digest, signature));
            return success && result.length >= 32 && bytes4(result) == bytes4(0x1626ba7e);
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 || (v != 27 && v != 28)) {
            return false;
        }
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    function _actor() private view returns (address) {
        return relaying && msg.sender == address(this) ? relaySigner : msg.sender;
    }

    function acceptAgreement(uint256 expectedNonce, uint256 deadline) external operation(expectedNonce, deadline) {
        if (state != State.Agreement) revert InvalidState();
        if (_actor() == tenant && !tenantAccepted) tenantAccepted = true;
        else if (_actor() == landlord && !landlordAccepted) landlordAccepted = true;
        else revert Unauthorized();
        if (tenantAccepted && landlordAccepted) state = State.AwaitingFunding;
        emit AgreementAccepted(_actor(), expectedNonce);
    }

    function fund(uint256 expectedNonce, uint256 deadline) external operation(expectedNonce, deadline) {
        _onlyTenant();
        if (state != State.AwaitingFunding) revert InvalidState();
        asset.safeTransferFrom(tenant, securityRequirement + fundingReserve);
        state = State.Active;
        emit Funded(securityRequirement + fundingReserve, expectedNonce);
    }

    function supply(uint256 assets, uint256 minShares, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        _onlyTenant();
        if (state != State.Active) revert InvalidState();
        if (assets == 0 || minShares == 0 || assets > asset.balanceOf(address(this))) revert InvalidAmount();
        uint256 shares = asset.supply(vault, assets, minShares);
        trackedShares += shares;
        totalSupplied += assets;
        if (securityValue() < securityRequirement) revert InsufficientSecurity();
        emit Supplied(assets, shares, expectedNonce);
    }

    /// @notice Accounting value only; a vault preview does not guarantee an executable cash withdrawal.
    function securityValue() public view returns (uint256) {
        return asset.balanceOf(address(this)) + vault.previewRedeem(trackedShares);
    }

    /// @notice Upper accounting bound. The release transaction must also complete actual redemption.
    function releasableEarnings() public view returns (uint256) {
        if (state != State.Active || !earningsReleaseAllowed) return 0;
        uint256 positionValue = vault.previewRedeem(trackedShares);
        uint256 value = asset.balanceOf(address(this)) + positionValue;
        uint256 protectedAmount = securityRequirement + fundingReserve;
        if (value <= protectedAmount) return 0;
        uint256 recoveredAndHeld = totalRedeemed + positionValue;
        if (recoveredAndHeld <= totalSupplied + releasedEarnings) return 0;
        uint256 earned = recoveredAndHeld - totalSupplied - releasedEarnings;
        uint256 surplus = value - protectedAmount;
        return earned < surplus ? earned : surplus;
    }

    function releaseEarnings(uint256 assets, uint256 maxSharesBurned, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        _onlyTenant();
        if (state != State.Active) revert InvalidState();
        if (!earningsReleaseAllowed) revert ReleaseForbidden();
        if (assets == 0 || assets > releasableEarnings()) revert InvalidAmount();
        uint256 cash = asset.balanceOf(address(this));
        if (cash < assets) {
            uint256 redeemed = assets - cash;
            uint256 burned = asset.withdraw(vault, redeemed, maxSharesBurned);
            if (burned > trackedShares) revert InsufficientSecurity();
            trackedShares -= burned;
            totalRedeemed += redeemed;
        }
        releasedEarnings += assets;
        asset.safeTransfer(personalWallet, assets);
        if (securityValue() < securityRequirement + fundingReserve) revert InsufficientSecurity();
        emit EarningsReleased(personalWallet, assets, expectedNonce);
    }

    function proposeClaim(uint256 assets, bytes32 evidenceHash, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        if (_actor() != landlord) revert Unauthorized();
        if (state != State.Active) revert InvalidState();
        if (assets > securityRequirement || (assets != 0 && evidenceHash == bytes32(0))) revert InvalidAmount();
        claimAmount = assets;
        claimEvidenceHash = evidenceHash;
        state = State.ClaimPending;
        emit ClaimProposed(assets, evidenceHash, expectedNonce);
    }

    function acceptClaim(uint256 minimumAssets, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        _onlyTenant();
        if (state != State.ClaimPending) revert InvalidState();
        _approveSettlement(claimAmount, minimumAssets, expectedNonce);
    }

    function contestClaim(uint256 expectedNonce, uint256 deadline) external operation(expectedNonce, deadline) {
        _onlyTenant();
        if (state != State.ClaimPending && (state != State.ReadyToSettle || arbitratedDecision)) revert InvalidState();
        state = State.ClaimContested;
        approvedLandlordAmount = 0;
        minimumSettlementAssets = 0;
        emit ClaimContested(expectedNonce);
    }

    function resolveClaim(uint256 landlordAssets, uint256 minimumAssets, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        if (_actor() != arbitrator) revert Unauthorized();
        if (state != State.ClaimContested && (state != State.ReadyToSettle || !arbitratedDecision)) {
            revert InvalidState();
        }
        if (landlordAssets > claimAmount || landlordAssets > securityRequirement) revert InvalidAmount();
        arbitratedDecision = true;
        _approveSettlement(landlordAssets, minimumAssets, expectedNonce);
    }

    /// @notice Anyone can execute an already authorized allocation; every recipient and amount is constrained.
    function settle(uint256 minRedeemedAssets, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        if (state != State.ReadyToSettle) revert InvalidState();
        if (trackedShares != 0) {
            uint256 redeemed = asset.redeem(vault, trackedShares, minRedeemedAssets);
            totalRedeemed += redeemed;
            trackedShares = 0;
        }
        uint256 available = asset.balanceOf(address(this));
        if (available < minimumSettlementAssets || available < approvedLandlordAmount) revert SettlementBelowMinimum();
        settledLandlordAmount = approvedLandlordAmount;
        settledTenantAmount = available - approvedLandlordAmount;
        state = State.Closed;
        if (settledLandlordAmount != 0) asset.safeTransfer(landlord, settledLandlordAmount);
        if (settledTenantAmount != 0) asset.safeTransfer(tenant, settledTenantAmount);
        emit Settled(settledLandlordAmount, settledTenantAmount, expectedNonce);
    }

    /// @notice Return accidental post-close donations only to the fixed tenant; no arbitrary rescue target.
    function returnDonations(uint256 minRedeemedAssets, uint256 expectedNonce, uint256 deadline)
        external
        operation(expectedNonce, deadline)
    {
        _onlyTenant();
        if (state != State.Closed) revert InvalidState();
        uint256 extraShares = vault.balanceOf(address(this));
        if (extraShares != 0) asset.redeem(vault, extraShares, minRedeemedAssets);
        uint256 cash = asset.balanceOf(address(this));
        if (cash == 0) revert InvalidAmount();
        asset.safeTransfer(tenant, cash);
        emit DonationReturned(cash, expectedNonce);
    }

    function _approveSettlement(uint256 landlordAssets, uint256 minimumAssets, uint256 operationNonce) private {
        if (minimumAssets < landlordAssets || minimumAssets > securityValue()) revert InvalidAmount();
        approvedLandlordAmount = landlordAssets;
        minimumSettlementAssets = minimumAssets;
        state = State.ReadyToSettle;
        emit SettlementApproved(_actor(), landlordAssets, minimumAssets, operationNonce);
    }

    function _onlyTenant() private view {
        if (_actor() != tenant) revert Unauthorized();
    }
}
