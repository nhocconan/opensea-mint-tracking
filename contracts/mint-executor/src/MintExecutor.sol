// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MintExecutor
/// @notice Minimal delegated-custody executor for a single Ledger-owned EOA
///         (ADR 0004's Executor fallback — promoted to the actual Phase 2
///         build target by this project's 2026-08-22 amendment, because
///         Ledger's device firmware today only whitelists EIP-7702
///         delegation to the Ethereum Foundation's reference contract, not
///         Safe's, making the ADR's originally-stated primary path
///         un-signable on real hardware regardless of chain readiness).
///
/// @dev Threat model this contract exists to close: a hot "operator" key
///      (a session key held by the automated mint-execution worker) must be
///      able to fire mint transactions with no human in the loop and no
///      per-transaction owner interaction, WITHOUT that key ever being able
///      to steal funds or the minted NFT, even if the key material and the
///      host running the worker are both fully compromised. Three
///      independent controls, all enforced on-chain, all required:
///        1. Allowlist: operator may only call a (target, selector) pair
///           the owner has explicitly, individually approved.
///        2. Recipient pin: the address argument at the allowlisted
///           `recipientOffset` within calldata MUST decode to `owner`, or
///           the call reverts — this is the actual theft-prevention
///           control. A compromised operator key can waste money (bounded
///           by the value cap below) but can never redirect a mint to an
///           attacker's address, because the recipient is checked against
///           immutable owner state, not trusted from the call arguments.
///        3. Rolling 24h value cap, per allowlisted target: bounds
///           accidental double-spend/replay/overlapping-plan exposure —
///           NOT a theft control (recipient pinning already owns that),
///           this is a coarse backstop sized to the largest single plan
///           the owner expects for that collection (ADR 0004 cap tiering).
///
///      Gas is deliberately NOT capped on-chain here (see ADR 0004's
///      2026-08-22 amendment) — gas cost is a property of the specific
///      call being executed and this project's mandatory pre-flight
///      simulation (never bypassable, off-chain) is the judged-correct
///      place to catch a gas anomaly before broadcast, same as the
///      browser_wallet scheme already relies on today.
contract MintExecutor {
    /// @notice The asset owner — the Ledger hardware wallet's EOA. Every
    ///         mint this contract ever executes delivers the NFT here.
    ///         Immutable: there is no owner-transfer function. A key
    ///         rotation means deploying a new Executor, which is the
    ///         correct shape for a hardware-wallet-rooted trust anchor —
    ///         it forces the same individually-reviewed re-allowlisting
    ///         discipline ADR 0004 requires for every collection.
    address public immutable owner;

    /// @notice The hot session-key address permitted to call executeMint.
    ///         Never permitted to touch allowlist/operator/withdraw state
    ///         — those are owner-only. Settable so a leaked/rotated
    ///         session key can be swapped out without redeploying or
    ///         re-allowlisting anything.
    address public operator;

    struct Allowlist {
        bool allowed;
        /// @dev Byte offset within `data` (the full calldata blob passed
        ///      to executeMint, selector included) where a right-aligned
        ///      32-byte address word holds the recipient argument. Varies
        ///      per mint function's ABI — set explicitly per entry, never
        ///      inferred, so a misconfigured offset fails closed (reads
        ///      the wrong word, almost certainly != owner, call reverts)
        ///      rather than silently checking nothing.
        uint256 recipientOffset;
        /// @dev Coarse, conservative per-collection backstop (ADR 0004 cap
        ///      tiering) — wei, rolling 24h window. NOT the precise
        ///      per-plan ceiling (that lives in Postgres, enforced by
        ///      packages/core's canFireMintPlan as part of the atomic
        ///      armed->executing transition, ADR 0005) — this is the
        ///      on-chain hard worst-case ceiling that survives a fully
        ///      compromised app/DB.
        uint256 valueCapWei;
    }

    /// @notice target contract => 4-byte selector => allowlist entry.
    mapping(address => mapping(bytes4 => Allowlist)) public allowlist;

    /// @dev Rolling-window accounting, keyed per target (not globally —
    ///      each collection's cap is independent, per ADR 0004: "sized to
    ///      the largest single plan the owner expects for THAT
    ///      collection"). This is a reset-on-first-use-after-expiry
    ///      window, not a continuously-recomputed ring-buffer rolling
    ///      window: `windowStart` only advances once `windowStart + 24h`
    ///      has actually elapsed, so it is anchored to real elapsed time
    ///      from the last reset rather than any calendar boundary — which
    ///      is precisely the property ADR 0004 requires ("a near-midnight
    ///      pair of mints cannot approach 2x the intended daily
    ///      exposure"). It is cheaper than a true rolling window and
    ///      documented here as exactly what it does and does not
    ///      guarantee, not asserted as more than it is.
    mapping(address => uint256) public windowStart;
    mapping(address => uint256) public windowSpentWei;

    /// @dev Minimal reentrancy guard. Not strictly required for
    ///      `executeMint` to be re-entered by itself (that would require
    ///      the reentrant caller to also be `operator`, which an
    ///      allowlisted target contract is not), but a compromised or
    ///      malicious target contract could still attempt other mischief
    ///      via a reentrant call mid-`executeMint`; cheap defense in depth
    ///      for a contract that calls arbitrary allowlisted external code.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private reentrancyStatus = NOT_ENTERED;

    event OperatorSet(address indexed previousOperator, address indexed newOperator);
    event AllowlistSet(
        address indexed target, bytes4 indexed selector, bool allowed, uint256 recipientOffset, uint256 valueCapWei
    );
    event MintExecuted(address indexed target, bytes4 indexed selector, uint256 value, address recipient);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error TargetNotAllowlisted();
    error RecipientMismatch(address expected, address actual);
    error CalldataTooShortForRecipient();
    error ValueCapExceeded(uint256 requested, uint256 remaining);
    error MintCallFailed(bytes returnData);
    error InsufficientBalance(uint256 requested, uint256 available);
    error Reentrant();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (reentrancyStatus == ENTERED) revert Reentrant();
        reentrancyStatus = ENTERED;
        _;
        reentrancyStatus = NOT_ENTERED;
    }

    /// @param _owner The Ledger EOA. Must be set correctly at deploy time
    ///        — this is itself a Ledger-signed deployment transaction
    ///        under ADR 0004's discipline, so the owner reviews the exact
    ///        constructor argument they're signing, same as every
    ///        allowlist entry afterward.
    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
    }

    /// @notice Accept ETH top-ups from anyone (the owner funds mint
    ///         spend from here, but a plain receive with no access
    ///         control costs nothing to allow and avoids a footgun where
    ///         an ordinary transfer reverts).
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorSet(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Revoke the current operator immediately (e.g. suspected key
    ///         compromise) without needing a replacement ready.
    function revokeOperator() external onlyOwner {
        emit OperatorSet(operator, address(0));
        operator = address(0);
    }

    /// @notice Per-collection, individually-reviewed allowlist entry (ADR
    ///         0004: "adding a contract address to the Roles Modifier... is
    ///         its own individually Ledger-signed transaction, reviewed by
    ///         the owner against the actual contract address at that
    ///         moment" — same discipline applies here for the Executor
    ///         path). Never batch multiple targets into one call from the
    ///         owner-facing UI, even though this function itself only
    ///         takes one entry at a time and can't be batched by
    ///         construction.
    function setAllowlist(address target, bytes4 selector, bool allowed, uint256 recipientOffset, uint256 valueCapWei)
        external
        onlyOwner
    {
        if (target == address(0)) revert ZeroAddress();
        allowlist[target][selector] =
            Allowlist({allowed: allowed, recipientOffset: recipientOffset, valueCapWei: valueCapWei});
        emit AllowlistSet(target, selector, allowed, recipientOffset, valueCapWei);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) {
            revert InsufficientBalance(amount, address(this).balance);
        }
        emit Withdrawn(to, amount);
        (bool success,) = to.call{value: amount}("");
        require(success, "withdraw transfer failed");
    }

    /// @notice The one entrypoint the hot operator key may ever call.
    ///         Executes `data` against `target`, forwarding `value` wei
    ///         from this contract's own balance (the operator's own EOA
    ///         never needs to hold mint-price-sized ETH — only enough for
    ///         its own gas, minimizing what a compromised session key's
    ///         own wallet balance ever exposes).
    /// @param target The allowlisted contract to call (the NFT/mint
    ///        contract, or an intermediary like an OpenSea-returned
    ///        `target` — allowlisted per ADR 0004's per-collection
    ///        discipline regardless of source).
    /// @param data Full calldata, selector included, exactly as will be
    ///        sent — this is what gets decoded for the recipient check,
    ///        so it must be the real, final calldata, not a template.
    /// @param value Wei to forward with the call (the mint price).
    function executeMint(address target, bytes calldata data, uint256 value) external onlyOperator nonReentrant {
        if (data.length < 4) revert TargetNotAllowlisted();
        bytes4 selector = bytes4(data[:4]);
        Allowlist memory entry = allowlist[target][selector];
        if (!entry.allowed) revert TargetNotAllowlisted();
        // `target` can never be address(0) past this point: setAllowlist
        // rejects address(0) at write time (ZeroAddress), so no allowlist
        // entry for it can ever exist to pass the `entry.allowed` check
        // above — noted for static analysis (a bare `target.call` below
        // reads as a missing zero-check in isolation, but the allowlist
        // already forecloses it).

        address recipient = _extractRecipient(data, entry.recipientOffset);
        if (recipient != owner) revert RecipientMismatch(owner, recipient);

        _consumeRollingWindow(target, entry.valueCapWei, value);

        if (value > address(this).balance) {
            revert InsufficientBalance(value, address(this).balance);
        }

        emit MintExecuted(target, selector, value, recipient);

        // Effects (window accounting, event) already applied above,
        // before this external call — checks-effects-interactions, so a
        // reentrant call (blocked by nonReentrant anyway) would also see
        // consistent state if it somehow got through.
        (bool success, bytes memory ret) = target.call{value: value}(data);
        if (!success) revert MintCallFailed(ret);
    }

    /// @dev Reads a right-aligned 32-byte address word out of `data` at
    ///      `offset`. Fails closed: an out-of-bounds offset reverts rather
    ///      than reading past the end of calldata or silently truncating.
    function _extractRecipient(bytes calldata data, uint256 offset) private pure returns (address) {
        if (data.length < offset + 32) revert CalldataTooShortForRecipient();
        bytes32 word;
        // forge-lint: disable-next-line(unsafe-typecast)
        assembly {
            word := calldataload(add(data.offset, offset))
        }
        return address(uint160(uint256(word)));
    }

    function _consumeRollingWindow(address target, uint256 capWei, uint256 value) private {
        uint256 start = windowStart[target];
        // block.timestamp is validator-manipulable by at most a few
        // seconds on any real chain (Robinhood Chain's own single-sequencer
        // FIFO ordering makes this even less of a concern than a
        // multi-validator L1) — irrelevant precision against a 24-hour
        // coarse spend backstop that isn't the theft control (recipient
        // pinning above is). Standard, accepted pattern for day-scale
        // windows; not a meaningful attack surface here.
        // forge-lint: disable-next-line(block-timestamp)
        if (start == 0 || block.timestamp >= start + 24 hours) {
            // First use, or the window has genuinely elapsed — reset
            // anchored to now, not to any calendar boundary.
            windowStart[target] = block.timestamp;
            windowSpentWei[target] = 0;
            start = block.timestamp;
        }
        uint256 spent = windowSpentWei[target];
        uint256 remaining = capWei > spent ? capWei - spent : 0;
        if (value > remaining) revert ValueCapExceeded(value, remaining);
        windowSpentWei[target] = spent + value;
    }
}
