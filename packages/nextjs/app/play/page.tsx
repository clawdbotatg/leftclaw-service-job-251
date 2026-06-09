"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { base } from "viem/chains";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

// Game status enum: 0 = IDLE, 1 = ACTIVE, 2 = COMPLETE
const STATUS = { IDLE: 0, ACTIVE: 1, COMPLETE: 2 } as const;

const BET_PRESETS: { label: string; value: bigint }[] = [
  { label: "10K", value: 10_000n },
  { label: "50K", value: 50_000n },
  { label: "100K", value: 100_000n },
  { label: "500K", value: 500_000n },
];

const RANK_LABELS = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

const fmtChips = (v?: bigint) => (v === undefined ? "—" : v.toLocaleString("en-US"));

// Cards from the contract are rank-only (1..13). Assign a stable display suit
// per position so the felt stays visually varied without faking game state.
const suitFor = (idx: number, isDealer: boolean) => SUITS[(idx * 2 + (isDealer ? 1 : 3)) % 4];

const Card = ({
  rank,
  suit,
  faceDown,
  dealIndex,
}: {
  rank?: number;
  suit?: string;
  faceDown?: boolean;
  dealIndex: number;
}) => {
  if (faceDown) {
    return (
      <div
        className="anim-card-deal flex h-24 w-16 items-center justify-center rounded-lg border border-cyan-500/40 bg-base-300 text-2xl text-cyan-400"
        style={{ animationDelay: `${dealIndex * 0.12}s`, boxShadow: "0 0 12px rgba(0,245,255,0.2)" }}
      >
        <span style={{ textShadow: "0 0 8px #00f5ff" }}>?</span>
      </div>
    );
  }
  const red = suit === "♥" || suit === "♦";
  return (
    <div
      className="anim-card-deal flex h-24 w-16 flex-col justify-between rounded-lg border border-cyan-500/30 bg-neutral-100 p-1 text-black"
      style={{ animationDelay: `${dealIndex * 0.12}s` }}
    >
      <span className={`text-lg font-bold leading-none ${red ? "text-red-600" : "text-black"}`}>
        {rank !== undefined ? RANK_LABELS[rank] : ""}
      </span>
      <span className={`self-center text-2xl ${red ? "text-red-600" : "text-black"}`}>{suit}</span>
      <span className={`self-end rotate-180 text-lg font-bold leading-none ${red ? "text-red-600" : "text-black"}`}>
        {rank !== undefined ? RANK_LABELS[rank] : ""}
      </span>
    </div>
  );
};

const Table: NextPage = () => {
  // Defer all wagmi-dependent hooks until the client has mounted. During the
  // static-export prerender pass the WagmiProvider is not in the tree yet, so
  // calling useConfig-backed hooks would throw WagmiProviderNotFoundError.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <Gate>
        <span className="loading loading-ring loading-lg text-cyan-400" />
      </Gate>
    );
  }
  return <TableInner />;
};

const TableInner = () => {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const [bet, setBet] = useState<bigint>(BET_PRESETS[0].value);
  const [pending, setPending] = useState(false);
  const [overlay, setOverlay] = useState<{ title: string; tone: "win" | "lose" | "push" } | null>(null);
  const prevStatus = useRef<number | undefined>(undefined);

  const { data: chipBalance } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "chipBalance",
    args: [address],
  });
  const { data: clawVaultChips } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "clawVaultChips",
  });
  const { data: gameData } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "games",
    args: [address],
  });
  const { data: playerCards } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "getPlayerCards",
    args: [address],
  });
  const { data: dealerCards } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "getDealerCards",
    args: [address],
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "BlackjackTable" });

  // games() returns [bet, status, seed, nonce, playerHasNatural, holeCardSuit]
  const status = gameData ? Number(gameData[1]) : STATUS.IDLE;
  const isActive = status === STATUS.ACTIVE;

  const playerHand = useMemo(() => (playerCards ?? []).map(c => Number(c)), [playerCards]);
  const dealerHand = useMemo(() => (dealerCards ?? []).map(c => Number(c)), [dealerCards]);

  const { data: playerValueRaw } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "handValue",
    args: [playerCards],
  });
  const playerValue = playerValueRaw !== undefined ? Number(playerValueRaw) : undefined;

  // Detect transition into COMPLETE to show a result overlay for ~3s.
  useEffect(() => {
    if (prevStatus.current === STATUS.ACTIVE && status === STATUS.COMPLETE) {
      const pv = playerValue ?? 0;
      let title = "THE CLAW LETS YOU GO";
      let tone: "win" | "lose" | "push" = "push";
      if (pv > 21) {
        title = "CRUSHED BY THE CLAW";
        tone = "lose";
      } else if (pv === 21 && playerHand.length === 2) {
        title = "CLAWD OUT";
        tone = "win";
      }
      // Refine by comparing to dealer when both stand.
      const dv = dealerHand.reduce((a, c) => a + Math.min(c >= 11 ? 10 : c === 1 ? 11 : c, 11), 0);
      if (pv <= 21) {
        if (dv > 21 || pv > Math.min(dv, 21)) {
          title = tone === "win" ? "CLAWD OUT" : "YOU ESCAPED THE CLAW";
          tone = "win";
        } else if (pv < dv && dv <= 21) {
          title = "CRUSHED BY THE CLAW";
          tone = "lose";
        }
      }
      setOverlay({ title, tone });
      const t = setTimeout(() => setOverlay(null), 3000);
      return () => clearTimeout(t);
    }
    prevStatus.current = status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const run = async (fn: "placeBet" | "hit" | "stand" | "doubleDown", args?: readonly [bigint]) => {
    setPending(true);
    try {
      await writeContractAsync({ functionName: fn, args: args as never });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("rejected") || msg.includes("denied")) {
        notification.error("Transaction rejected");
      } else {
        notification.error("Transaction failed: " + msg.slice(0, 80));
      }
    } finally {
      setPending(false);
    }
  };

  // Wallet gating helpers
  if (!isConnected) {
    return (
      <Gate>
        <RainbowKitCustomConnectButton />
      </Gate>
    );
  }
  if (chainId !== base.id) {
    return (
      <Gate>
        <button className="btn btn-warning" onClick={() => switchChain({ chainId: base.id })}>
          Switch to Base
        </button>
      </Gate>
    );
  }

  const canDouble = isActive && playerHand.length === 2;

  return (
    <div className="relative flex-1 overflow-hidden">
      <div className="neon-grid absolute inset-0 -z-10 opacity-60" />

      {/* HUD */}
      <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between text-sm">
        <div>
          <span className="text-base-content/50 tracking-widest text-xs">CHIPS</span>
          <div className="text-2xl font-bold text-cyan-400">{fmtChips(chipBalance)}</div>
        </div>
        <Link href="/" className="text-base-content/60 hover:text-cyan-400 transition-colors">
          ← Lobby
        </Link>
        <div className="text-right">
          <span className="text-base-content/50 tracking-widest text-xs">VAULT</span>
          <div className="text-xl font-bold text-purple-400">{fmtChips(clawVaultChips)}</div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 pb-12 flex flex-col gap-8">
        {/* The Claw (dealer) */}
        <section className="card neon-border bg-base-200">
          <div className="card-body">
            <div className="flex items-center gap-3">
              <span className={`text-4xl ${isActive ? "anim-claw-pinch" : ""}`}>🦞</span>
              <div>
                <div className="neon-text-pink font-bold tracking-widest">THE CLAW</div>
                <div className="text-xs text-base-content/50">Dealer</div>
              </div>
            </div>
            <div className="flex gap-2 mt-3 min-h-24 flex-wrap">
              {dealerHand.length === 0 && <span className="text-base-content/30 self-center">Awaiting bet…</span>}
              {dealerHand.map((rank, i) => {
                // While active, the dealer's hole card (index 1) stays face down.
                const faceDown = isActive && i === 1;
                return <Card key={`d-${i}`} rank={rank} suit={suitFor(i, true)} faceDown={faceDown} dealIndex={i} />;
              })}
            </div>
          </div>
        </section>

        {/* Player */}
        <section
          className={`card neon-border bg-base-200 ${
            overlay?.tone === "win" ? "anim-win-flash" : overlay?.tone === "lose" ? "anim-bust-shake" : ""
          }`}
        >
          <div className="card-body">
            <div className="flex items-center justify-between">
              <div className="neon-text-cyan font-bold tracking-widest">YOUR HAND</div>
              {playerValue !== undefined && playerHand.length > 0 && (
                <div className="badge badge-lg border-cyan-500/40 bg-base-300 text-cyan-400">{playerValue}</div>
              )}
            </div>
            <div className="flex gap-2 mt-3 min-h-24 flex-wrap">
              {playerHand.length === 0 && (
                <span className="text-base-content/30 self-center">Place a bet to deal.</span>
              )}
              {playerHand.map((rank, i) => (
                <Card key={`p-${i}`} rank={rank} suit={suitFor(i, false)} dealIndex={i} />
              ))}
            </div>
          </div>
        </section>

        {/* Controls */}
        {isActive ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button className="btn btn-primary" disabled={pending} onClick={() => run("hit")}>
              DRAW
            </button>
            <button className="btn btn-secondary" disabled={pending} onClick={() => run("stand")}>
              HOLD
            </button>
            <button className="btn btn-accent" disabled={pending || !canDouble} onClick={() => run("doubleDown")}>
              DOUBLE DOWN
            </button>
          </div>
        ) : (
          <div className="card neon-border bg-base-200">
            <div className="card-body gap-4">
              <div className="text-center neon-text-pink font-bold tracking-widest">SELECT YOUR BET</div>
              <div className="grid grid-cols-4 gap-2">
                {BET_PRESETS.map(p => (
                  <button
                    key={p.label}
                    className={`btn ${bet === p.value ? "btn-primary" : "btn-outline"}`}
                    onClick={() => setBet(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="text-center text-sm text-base-content/60">
                Betting <span className="text-cyan-400 font-bold">{fmtChips(bet)}</span> chips
              </div>
              <button
                className="btn btn-primary btn-lg tracking-widest"
                disabled={pending || (chipBalance !== undefined && chipBalance < bet)}
                onClick={() => run("placeBet", [bet])}
                style={{ boxShadow: "0 0 20px rgba(0,245,255,0.35)" }}
              >
                {chipBalance !== undefined && chipBalance < bet ? "NOT ENOUGH CHIPS" : "PLACE BET"}
              </button>
              {chipBalance !== undefined && chipBalance < bet && (
                <Link href="/" className="link link-secondary text-center text-sm">
                  Feed The Claw to get more chips →
                </Link>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Result overlay */}
      {overlay && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div
            className={`text-center text-4xl sm:text-5xl font-black tracking-widest px-8 ${
              overlay.tone === "win" ? "neon-text-cyan" : overlay.tone === "lose" ? "neon-text-pink" : "text-purple-400"
            }`}
          >
            {overlay.title}
          </div>
        </div>
      )}
    </div>
  );
};

const Gate = ({ children }: { children: React.ReactNode }) => (
  <div className="relative flex-1 flex items-center justify-center">
    <div className="neon-grid absolute inset-0 -z-10 opacity-60" />
    <div className="card neon-border bg-base-200">
      <div className="card-body items-center gap-4">
        <span className="text-5xl anim-neon-pulse">🦞</span>
        <p className="text-base-content/70">Connect to approach The Table.</p>
        {children}
      </div>
    </div>
  </div>
);

export default Table;
