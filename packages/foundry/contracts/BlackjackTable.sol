// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CLAWD Blackjack — Neon Tokyo
 * @notice On-chain single-player Blackjack table. Players buy chips with CLAWD (or CV)
 *         tokens, place bets, and play against an automated dealer. The "Claw Vault" holds
 *         the token reserves backing the chip economy and pays out winnings.
 * @dev Single-player-per-address model: each address may have at most one active game.
 *      All token movements use SafeERC20. State-changing entry points are guarded by
 *      ReentrancyGuard and follow Checks-Effects-Interactions. Ownership uses Ownable2Step.
 *
 *      NOTE ON RANDOMNESS: card randomness is derived from blockhash + per-player nonce.
 *      This is suitable for a low-stakes neon arcade game but is NOT secure against a
 *      determined miner/validator. Do not treat this as cryptographically secure RNG.
 */
contract BlackjackTable is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum GameStatus {
        IDLE,
        ACTIVE,
        COMPLETE
    }

    struct GameState {
        uint8[] playerCards;
        uint8[] dealerCards;
        uint256 bet;
        GameStatus status;
        bytes32 seed;
        uint256 nonce;
        bool playerHasNatural; // dealt blackjack on the initial 2 cards
    }

    // ---------------------------------------------------------------------
    // Token configuration
    // ---------------------------------------------------------------------

    /// @notice CLAWD token (immutable, set at construction).
    IERC20 public immutable clawd;

    /// @notice CV token (owner-updatable, may be the zero address as a placeholder).
    IERC20 public cvToken;

    /// @notice Chips minted per whole CLAWD token (normalized for 18 decimals).
    uint256 public clawdChipRate = 10_000;

    /// @notice Chips minted per whole CV token (normalized for 18 decimals).
    uint256 public cvChipRate = 1_000;

    // ---------------------------------------------------------------------
    // Balances & game state
    // ---------------------------------------------------------------------

    /// @notice Player chip balance (off-table chips, spendable on bets or withdrawable).
    mapping(address => uint256) public chipBalance;

    /// @notice Current game state per player.
    mapping(address => GameState) public games;

    /// @notice Monotonic per-player nonce, incremented every new hand for seed uniqueness.
    mapping(address => uint256) public playerNonce;

    // ---------------------------------------------------------------------
    // Claw Vault accounting
    // ---------------------------------------------------------------------

    /// @notice CLAWD tokens held in the Claw Vault backing the chip economy.
    uint256 public clawVaultClawd;

    /// @notice CV tokens held in the Claw Vault backing the chip economy.
    uint256 public clawVaultCV;

    /// @notice Chip reserve held by the house to cover player winnings.
    uint256 public clawVaultChips;

    // ---------------------------------------------------------------------
    // Bet limits
    // ---------------------------------------------------------------------

    uint256 public constant MIN_BET = 10_000;
    uint256 public constant MAX_BET = 500_000;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ChipsPurchased(address indexed player, uint256 chips, address indexed token);
    event HandStarted(address indexed player, uint256 bet, uint256 nonce);
    event CardDealt(address indexed player, uint8 card, uint8 suit, bool isClaw);
    event HandResolved(address indexed player, uint256 payout, string result);
    event ClawVaultFunded(uint256 clawdAmount, uint256 cvAmount);
    event ChipsWithdrawn(address indexed player, uint256 chips, uint256 clawdAmount);
    event ChipRatesUpdated(uint256 clawdChipRate, uint256 cvChipRate);
    event CVTokenUpdated(address indexed newCVToken);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param clawdToken CLAWD ERC20 token address (must be non-zero).
     * @param cvToken_   CV ERC20 token address (may be zero as a placeholder).
     * @dev Deployer becomes the initial owner; use {transferOwnership} + {acceptOwnership}
     *      (Ownable2Step) to hand the table to the client wallet.
     */
    constructor(address clawdToken, address cvToken_) Ownable(msg.sender) {
        require(clawdToken != address(0), "CLAWD addr zero");
        clawd = IERC20(clawdToken);
        cvToken = IERC20(cvToken_);
    }

    // ---------------------------------------------------------------------
    // Chip purchase
    // ---------------------------------------------------------------------

    /**
     * @notice Buy chips by depositing CLAWD into the Claw Vault.
     * @param clawdAmount Amount of CLAWD (in wei, 18 decimals) to deposit.
     */
    function buyChipsWithCLAWD(uint256 clawdAmount) external nonReentrant whenNotPaused {
        require(clawdAmount > 0, "amount zero");

        uint256 chips = (clawdAmount * clawdChipRate) / 1e18;
        require(chips > 0, "chips zero");

        // Effects
        chipBalance[msg.sender] += chips;
        clawVaultClawd += clawdAmount;

        // Interactions
        clawd.safeTransferFrom(msg.sender, address(this), clawdAmount);

        emit ChipsPurchased(msg.sender, chips, address(clawd));
    }

    /**
     * @notice Buy chips by depositing CV into the Claw Vault.
     * @param cvAmount Amount of CV (in wei, 18 decimals) to deposit.
     */
    function buyChipsWithCV(uint256 cvAmount) external nonReentrant whenNotPaused {
        require(address(cvToken) != address(0), "CV not set");
        require(cvAmount > 0, "amount zero");

        uint256 chips = (cvAmount * cvChipRate) / 1e18;
        require(chips > 0, "chips zero");

        // Effects
        chipBalance[msg.sender] += chips;
        clawVaultCV += cvAmount;

        // Interactions
        cvToken.safeTransferFrom(msg.sender, address(this), cvAmount);

        emit ChipsPurchased(msg.sender, chips, address(cvToken));
    }

    // ---------------------------------------------------------------------
    // Game flow
    // ---------------------------------------------------------------------

    /**
     * @notice Place a bet and deal the opening hand.
     * @param chipAmount Bet size in chips, within [MIN_BET, MAX_BET].
     */
    function placeBet(uint256 chipAmount) external nonReentrant whenNotPaused {
        GameState storage game = games[msg.sender];
        require(game.status != GameStatus.ACTIVE, "active game");
        require(chipAmount >= MIN_BET && chipAmount <= MAX_BET, "bet out of range");
        require(chipBalance[msg.sender] >= chipAmount, "insufficient chips");

        // Vault solvency: the house must be able to cover the maximum possible payout.
        require(clawVaultChips >= _maxPayout(chipAmount), "vault insolvent");

        // Effects: take the bet and roll a fresh game.
        chipBalance[msg.sender] -= chipAmount;
        playerNonce[msg.sender] += 1;
        bytes32 seed = _newSeed(msg.sender);

        delete games[msg.sender];
        game = games[msg.sender];
        game.bet = chipAmount;
        game.seed = seed;
        game.nonce = playerNonce[msg.sender];

        emit HandStarted(msg.sender, chipAmount, game.nonce);

        // Deal: player[0], dealer[0], player[1], dealer[1] (dealer[1] is the hole card).
        _dealToPlayer(msg.sender, 0);
        _dealToDealer(msg.sender, 1);
        _dealToPlayer(msg.sender, 2);
        _dealToDealerSilent(msg.sender, 3); // hole card: dealt but not emitted

        // Natural blackjack detection on opening two cards.
        bool playerNatural = _handValue(game.playerCards) == 21;
        bool dealerNatural = _handValue(game.dealerCards) == 21;

        if (playerNatural || dealerNatural) {
            game.playerHasNatural = playerNatural;
            // Reveal the hole card for transparency on immediate resolution.
            emit CardDealt(msg.sender, game.dealerCards[1], 0, false);
            game.status = GameStatus.ACTIVE; // briefly active so _resolveHand can finalize
            _resolveHand(msg.sender);
        } else {
            game.status = GameStatus.ACTIVE;
        }
    }

    /**
     * @notice Draw one more card to the player's hand.
     * @dev Auto-resolves as a loss on bust.
     */
    function hit() external nonReentrant whenNotPaused {
        GameState storage game = games[msg.sender];
        require(game.status == GameStatus.ACTIVE, "no active game");

        _dealToPlayer(msg.sender, _drawIndex(game));

        if (_handValue(game.playerCards) > 21) {
            _resolveHand(msg.sender);
        }
    }

    /**
     * @notice Stand: reveal the dealer's hole card, run the dealer, and resolve.
     */
    function stand() external nonReentrant whenNotPaused {
        GameState storage game = games[msg.sender];
        require(game.status == GameStatus.ACTIVE, "no active game");

        _runDealer(msg.sender);
        _resolveHand(msg.sender);
    }

    /**
     * @notice Double down: double the bet, take exactly one card, then resolve.
     * @dev Only valid on the opening two-card hand.
     */
    function doubleDown() external nonReentrant whenNotPaused {
        GameState storage game = games[msg.sender];
        require(game.status == GameStatus.ACTIVE, "no active game");
        require(game.playerCards.length == 2, "not initial hand");

        uint256 additional = game.bet;
        require(chipBalance[msg.sender] >= additional, "insufficient chips");

        // Doubling the bet raises the worst-case payout; re-check vault solvency.
        require(clawVaultChips >= _maxPayout(game.bet + additional), "vault insolvent");

        // Effects
        chipBalance[msg.sender] -= additional;
        game.bet += additional;

        // Exactly one card to the player.
        _dealToPlayer(msg.sender, _drawIndex(game));

        if (_handValue(game.playerCards) > 21) {
            _resolveHand(msg.sender);
        } else {
            _runDealer(msg.sender);
            _resolveHand(msg.sender);
        }
    }

    // ---------------------------------------------------------------------
    // Emergency player withdrawal (chip safety valve)
    // ---------------------------------------------------------------------

    /**
     * @notice Convert unplayed chips back into CLAWD at the current rate.
     * @dev Last-resort path so players can always recover unplayed chips when the vault
     *      holds CLAWD. Requires no active game. Burns chips and pays CLAWD from the vault.
     * @param chipAmount Number of chips to redeem.
     */
    function withdrawChips(uint256 chipAmount) external nonReentrant {
        require(chipAmount > 0, "amount zero");
        require(games[msg.sender].status != GameStatus.ACTIVE, "active game");
        require(chipBalance[msg.sender] >= chipAmount, "insufficient chips");

        // chips -> CLAWD at the current rate (inverse of buyChipsWithCLAWD).
        uint256 clawdAmount = (chipAmount * 1e18) / clawdChipRate;
        require(clawdAmount > 0, "dust");
        require(clawVaultClawd >= clawdAmount, "vault lacks CLAWD");

        // Effects
        chipBalance[msg.sender] -= chipAmount;
        clawVaultClawd -= clawdAmount;

        // Interactions
        clawd.safeTransfer(msg.sender, clawdAmount);

        emit ChipsWithdrawn(msg.sender, chipAmount, clawdAmount);
    }

    // ---------------------------------------------------------------------
    // Owner: vault funding & management
    // ---------------------------------------------------------------------

    /**
     * @notice Owner deposits CLAWD into the Claw Vault and mints matching house chips.
     * @param clawdAmount Amount of CLAWD (18 decimals) to deposit.
     */
    function fundClawVaultWithCLAWD(uint256 clawdAmount) external onlyOwner nonReentrant {
        require(clawdAmount > 0, "amount zero");

        uint256 chips = (clawdAmount * clawdChipRate) / 1e18;
        require(chips > 0, "chips zero");

        // Effects
        clawVaultClawd += clawdAmount;
        clawVaultChips += chips;

        // Interactions
        clawd.safeTransferFrom(msg.sender, address(this), clawdAmount);

        emit ClawVaultFunded(clawdAmount, 0);
    }

    /**
     * @notice Owner deposits CV into the Claw Vault and mints matching house chips.
     * @param cvAmount Amount of CV (18 decimals) to deposit.
     */
    function fundClawVaultWithCV(uint256 cvAmount) external onlyOwner nonReentrant {
        require(address(cvToken) != address(0), "CV not set");
        require(cvAmount > 0, "amount zero");

        uint256 chips = (cvAmount * cvChipRate) / 1e18;
        require(chips > 0, "chips zero");

        // Effects
        clawVaultCV += cvAmount;
        clawVaultChips += chips;

        // Interactions
        cvToken.safeTransferFrom(msg.sender, address(this), cvAmount);

        emit ClawVaultFunded(0, cvAmount);
    }

    /**
     * @notice Owner withdraws CLAWD from the vault, burning the corresponding house chips.
     * @param amount Amount of CLAWD (18 decimals) to withdraw.
     */
    function withdrawClawVaultCLAWD(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "amount zero");
        require(clawVaultClawd >= amount, "vault lacks CLAWD");

        uint256 chips = (amount * clawdChipRate) / 1e18;
        require(clawVaultChips >= chips, "vault lacks chips");

        // Effects
        clawVaultClawd -= amount;
        clawVaultChips -= chips;

        // Interactions
        clawd.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Owner withdraws CV from the vault, burning the corresponding house chips.
     * @param amount Amount of CV (18 decimals) to withdraw.
     */
    function withdrawClawVaultCV(uint256 amount) external onlyOwner nonReentrant {
        require(address(cvToken) != address(0), "CV not set");
        require(amount > 0, "amount zero");
        require(clawVaultCV >= amount, "vault lacks CV");

        uint256 chips = (amount * cvChipRate) / 1e18;
        require(clawVaultChips >= chips, "vault lacks chips");

        // Effects
        clawVaultCV -= amount;
        clawVaultChips -= chips;

        // Interactions
        cvToken.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Owner: configuration
    // ---------------------------------------------------------------------

    /// @notice Update chip purchase rates for CLAWD and CV.
    function setChipRates(uint256 newClawdRate, uint256 newCvRate) external onlyOwner {
        require(newClawdRate > 0 && newCvRate > 0, "rate zero");
        clawdChipRate = newClawdRate;
        cvChipRate = newCvRate;
        emit ChipRatesUpdated(newClawdRate, newCvRate);
    }

    /// @notice Update the CV token address.
    function setCVToken(address newCVToken) external onlyOwner {
        cvToken = IERC20(newCVToken);
        emit CVTokenUpdated(newCVToken);
    }

    /// @notice Emergency stop: halt deposits and gameplay.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume after an emergency stop.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Return the player's current hand cards.
    function getPlayerCards(address player) external view returns (uint8[] memory) {
        return games[player].playerCards;
    }

    /// @notice Return the dealer's current hand cards.
    function getDealerCards(address player) external view returns (uint8[] memory) {
        return games[player].dealerCards;
    }

    /// @notice Compute the best blackjack value of an arbitrary hand.
    function handValue(uint8[] memory cards) external pure returns (uint256) {
        return _handValue(cards);
    }

    // ---------------------------------------------------------------------
    // Internal: dealing
    // ---------------------------------------------------------------------

    function _dealToPlayer(address player, uint256 index) internal {
        GameState storage game = games[player];
        (uint8 card, uint8 suit) = _dealCard(game.seed, index);
        game.playerCards.push(card);
        emit CardDealt(player, card, suit, false);
    }

    function _dealToDealer(address player, uint256 index) internal {
        GameState storage game = games[player];
        (uint8 card, uint8 suit) = _dealCard(game.seed, index);
        game.dealerCards.push(card);
        emit CardDealt(player, card, suit, false);
    }

    /// @dev Deals the dealer's hole card without emitting it (kept face down).
    function _dealToDealerSilent(address player, uint256 index) internal {
        GameState storage game = games[player];
        (uint8 card,) = _dealCard(game.seed, index);
        game.dealerCards.push(card);
    }

    /// @dev Reveal-and-draw for the dealer during stand/double resolution.
    function _runDealer(address player) internal {
        GameState storage game = games[player];

        // Reveal the existing hole card (dealerCards[1]) for observers.
        if (game.dealerCards.length >= 2) {
            emit CardDealt(player, game.dealerCards[1], 0, false);
        }

        // Dealer draws until reaching 17 or more (hits soft 17 per spec).
        uint256 index = _drawIndex(game);
        while (true) {
            (uint256 value, bool isSoft) = _handValueSoft(game.dealerCards);
            if (value > 17) break;
            if (value == 17 && !isSoft) break; // stand on hard 17, hit on soft 17

            _dealToDealer(player, index);
            index += 1;
        }
    }

    /// @dev Next keccak index for a hand: 4 opening cards already consume indices 0..3.
    function _drawIndex(GameState storage game) internal view returns (uint256) {
        return game.playerCards.length + game.dealerCards.length;
    }

    // ---------------------------------------------------------------------
    // Internal: resolution
    // ---------------------------------------------------------------------

    /**
     * @dev Settle the active hand, move chips between player and vault, and finalize state.
     *      Payout semantics (winnings on top of the returned stake):
     *        - CLAWD_OUT (player natural, dealer not): pays bet * 3/2 winnings.
     *        - WIN  (player beats dealer or dealer busts): pays bet winnings (1:1).
     *        - PUSH (equal, or both natural): stake returned, no chips change hands.
     *        - LOSS (player busts or dealer wins): stake forfeited to the vault.
     */
    function _resolveHand(address player) internal {
        GameState storage game = games[player];
        uint256 bet = game.bet;

        uint256 playerVal = _handValue(game.playerCards);
        uint256 dealerVal = _handValue(game.dealerCards);

        bool playerBust = playerVal > 21;
        bool dealerBust = dealerVal > 21;
        bool playerNatural = game.playerHasNatural;
        bool dealerNatural = (game.dealerCards.length == 2 && dealerVal == 21);

        uint256 payout; // winnings paid from the vault on top of the stake
        string memory result;
        uint256 returnToPlayer; // total chips credited back to the player balance

        if (playerNatural && dealerNatural) {
            // Both blackjack: push.
            result = "PUSH";
            returnToPlayer = bet;
        } else if (playerNatural) {
            // Player blackjack pays 3:2.
            payout = (bet * 3) / 2;
            result = "CLAWD_OUT";
            returnToPlayer = bet + payout;
        } else if (playerBust) {
            result = "LOSS";
        } else if (dealerNatural) {
            // Dealer blackjack, player did not have one.
            result = "LOSS";
        } else if (dealerBust || playerVal > dealerVal) {
            payout = bet;
            result = "WIN";
            returnToPlayer = bet + payout;
        } else if (playerVal == dealerVal) {
            result = "PUSH";
            returnToPlayer = bet;
        } else {
            result = "LOSS";
        }

        // Move chips between vault and player (CEI: state before any external effect).
        if (payout > 0) {
            // Winnings come out of the house chip reserve.
            clawVaultChips -= payout;
            chipBalance[player] += returnToPlayer;
        } else if (returnToPlayer > 0) {
            // Push: return the stake, vault unaffected.
            chipBalance[player] += returnToPlayer;
        } else {
            // Loss: the staked chips are absorbed into the vault reserve.
            clawVaultChips += bet;
        }

        game.status = GameStatus.COMPLETE;

        emit HandResolved(player, payout, result);
    }

    /// @dev Worst-case payout for a bet (blackjack 3:2): the stake plus 3/2 winnings.
    function _maxPayout(uint256 bet) internal pure returns (uint256) {
        return bet + (bet * 3) / 2;
    }

    // ---------------------------------------------------------------------
    // Internal: cards & randomness
    // ---------------------------------------------------------------------

    /**
     * @dev Derive a card and suit from a seed and draw index.
     * @return card uint8 in [1, 13] (1 = Ace, 11 = Jack, 12 = Queen, 13 = King).
     * @return suit uint8 in [0, 3].
     */
    function _dealCard(bytes32 seed, uint256 index) internal pure returns (uint8 card, uint8 suit) {
        bytes32 h = keccak256(abi.encodePacked(seed, index));
        card = uint8(uint8(h[0]) % 13) + 1;
        suit = uint8(uint8(h[1]) % 4);
    }

    /**
     * @dev Best blackjack value of a hand with ace flexibility.
     *      Aces count as 11 then drop to 1 while busting. Returns the best non-bust value,
     *      or the minimal bust value when every configuration busts.
     */
    function _handValue(uint8[] memory cards) internal pure returns (uint256) {
        (uint256 value,) = _handValueSoft(cards);
        return value;
    }

    /**
     * @dev Like {_handValue} but also reports whether the hand is "soft" (an ace is still
     *      counted as 11). Used for the dealer's soft-17 rule.
     */
    function _handValueSoft(uint8[] memory cards) internal pure returns (uint256 value, bool isSoft) {
        uint256 total;
        uint256 aces;

        for (uint256 i = 0; i < cards.length; i++) {
            uint8 c = cards[i];
            if (c == 1) {
                aces += 1;
                total += 11;
            } else if (c >= 10) {
                // 10, Jack, Queen, King all count as 10.
                total += 10;
            } else {
                total += c;
            }
        }

        // Reduce aces from 11 to 1 while the hand busts.
        uint256 softAces = aces;
        while (total > 21 && softAces > 0) {
            total -= 10;
            softAces -= 1;
        }

        value = total;
        isSoft = (softAces > 0); // an ace is still counted as 11
    }

    /// @dev Fresh per-hand seed from the player, previous blockhash, and player nonce.
    function _newSeed(address player) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(player, blockhash(block.number - 1), playerNonce[player]));
    }
}
