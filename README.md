# CLAWD Blackjack — Neon Tokyo

Provably-fair on-chain Blackjack on Base. Beat The Claw. Lose to The Claw. The blockchain remembers.

## Live App

Deployed on IPFS via bgipfs — see job delivery message for the canonical live link.

## Smart Contract

**BlackjackTable** — `0x3d0b667391E0A059D5dA59a28c32718E6312B8e4` on Base mainnet

- [View on Basescan](https://basescan.org/address/0x3d0b667391E0A059D5dA59a28c32718E6312B8e4)
- Owner: `0xFE968dE21eb0E77d5877477C31a04A3075c0086E` (pending `acceptOwnership()`)
- CLAWD token: `0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`
- CV token: not yet configured (call `setCVToken(address)` as owner)

## How It Works

1. **Buy chips** — Send CLAWD tokens to the contract. 100 CLAWD → 10,000 chips.
2. **Place a bet** — Choose 10K / 50K / 100K / 500K chips per hand.
3. **Play** — Hit (DRAW), Stand (HOLD), or Double Down.
4. **Win/Lose** — Chips are settled on-chain at the end of each hand.
5. **The Claw** — The dealer. It never bluffs. It never tilts. It has claws.

## Randomness

Cards are drawn using blockhash-based randomness (`block.prevrandao` seeded with per-game nonce). Appropriate for a community game; not suitable for high-stakes use. See [EIP-4399](https://eips.ethereum.org/EIPS/eip-4399) for context on PREVRANDAO security properties.

## Contract Ownership

The deployer called `transferOwnership(0xFE968dE21eb0E77d5877477C31a04A3075c0086E)`. The designated owner must call `acceptOwnership()` on the contract to complete the Ownable2Step handoff before administrative functions are accessible.

## Tech Stack

- **Scaffold-ETH 2** (Foundry flavor)
- **Solidity 0.8.24** — Ownable2Step, Pausable, ReentrancyGuard, SafeERC20
- **Base** (chain 8453)
- **Next.js 15** — static export (`output: "export"`)
- **RainbowKit + Wagmi + Viem**
- **DaisyUI + Tailwind CSS** — Neon Tokyo theme
- **bgipfs** — IPFS hosting

## Development

```bash
# Install deps
yarn install

# Local chain + deploy
yarn chain
yarn deploy

# Frontend dev server
yarn start

# Build static export
cd packages/nextjs && yarn build
```

## Audit

Solidity audit completed before deployment. Key findings addressed:
- C-1: `clawdChipRate` corrected from 10,000 to 100 (100 CLAWD → 10,000 chips, not 1,000,000)
- All CEI pattern violations resolved
- Ownable2Step handoff pattern enforced

## LeftClaw Services

Built by [LeftClaw Services](https://leftclaw.services) — Job #251.
