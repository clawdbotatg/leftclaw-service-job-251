"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { parseUnits } from "viem";
import { base } from "viem/chains";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useScaffoldReadContract, useScaffoldWriteContract, useWriteAndOpen } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

const TABLE_ADDRESS = "0x3d0b667391e0a059d5da59a28c32718e6312b8e4" as const;
const CHIPS_PER_CLAWD = 100n;

const fmtChips = (v?: bigint) => (v === undefined ? "—" : v.toLocaleString("en-US"));

const Lobby: NextPage = () => {
  // Defer wagmi hooks until the client mounts (WagmiProvider is absent during
  // the static-export prerender pass).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <div className="relative flex-1 overflow-hidden">
        <div className="neon-grid absolute inset-0 -z-10" />
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <span className="text-7xl anim-neon-pulse">🦞</span>
          <span className="loading loading-ring loading-lg text-cyan-400" />
        </div>
      </div>
    );
  }
  return <LobbyInner />;
};

const LobbyInner = () => {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const [token, setToken] = useState<"CLAWD" | "CV">("CLAWD");
  const [amount, setAmount] = useState("");
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalCooldown, setApprovalCooldown] = useState(false);
  const [buying, setBuying] = useState(false);

  const { data: chipBalance } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "chipBalance",
    args: [address],
  });

  const { data: clawVaultChips } = useScaffoldReadContract({
    contractName: "BlackjackTable",
    functionName: "clawVaultChips",
  });

  const { data: allowance } = useScaffoldReadContract({
    contractName: "CLAWD",
    functionName: "allowance",
    args: [address, TABLE_ADDRESS],
  });

  const { writeContractAsync: writeTable } = useScaffoldWriteContract({ contractName: "BlackjackTable" });
  const { writeContractAsync: writeClawd } = useScaffoldWriteContract({ contractName: "CLAWD" });
  const { writeAndOpen } = useWriteAndOpen();

  // Parse the input amount into wei (18 decimals). Guard against bad input.
  let amountWei: bigint | undefined;
  try {
    amountWei = amount && Number(amount) > 0 ? parseUnits(amount, 18) : undefined;
  } catch {
    amountWei = undefined;
  }

  const previewChips = amountWei !== undefined ? (amountWei * CHIPS_PER_CLAWD) / 10n ** 18n : undefined;
  const needsApproval =
    token === "CLAWD" && amountWei !== undefined && (allowance === undefined || allowance < amountWei);

  const handleApprove = async () => {
    if (!amountWei) return;
    setApprovalSubmitting(true);
    setApprovalCooldown(true);
    try {
      await writeAndOpen(() => writeClawd({ functionName: "approve", args: [TABLE_ADDRESS, amountWei] }));
      notification.success("CLAWD approved");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("rejected") || msg.includes("denied")) {
        notification.error("Transaction rejected");
      } else {
        notification.error("Transaction failed: " + msg.slice(0, 80));
      }
    } finally {
      setApprovalSubmitting(false);
      // brief cooldown so the allowance read can settle before showing Buy
      setTimeout(() => setApprovalCooldown(false), 3000);
    }
  };

  const handleBuy = async () => {
    if (!amountWei) return;
    setBuying(true);
    try {
      await writeAndOpen(() => writeTable({ functionName: "buyChipsWithCLAWD", args: [amountWei] }));
      notification.success("The Claw is fed. Chips acquired.");
      setAmount("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("rejected") || msg.includes("denied")) {
        notification.error("Transaction rejected");
      } else {
        notification.error("Transaction failed: " + msg.slice(0, 80));
      }
    } finally {
      setBuying(false);
    }
  };

  const renderActionButton = () => {
    if (!isConnected) {
      return (
        <div className="flex justify-center">
          <RainbowKitCustomConnectButton />
        </div>
      );
    }
    if (chainId !== base.id) {
      return (
        <button className="btn btn-warning w-full" onClick={() => switchChain({ chainId: base.id })}>
          Switch to Base
        </button>
      );
    }
    if (token === "CV") {
      return (
        <button className="btn btn-disabled w-full" disabled>
          CV token not configured yet
        </button>
      );
    }
    if (!amountWei) {
      return (
        <button className="btn btn-disabled w-full" disabled>
          Enter an amount
        </button>
      );
    }
    if (needsApproval) {
      return (
        <button
          className="btn btn-secondary w-full"
          onClick={handleApprove}
          disabled={approvalSubmitting || approvalCooldown}
        >
          {approvalSubmitting ? "Approving…" : "Approve CLAWD"}
        </button>
      );
    }
    return (
      <button className="btn btn-primary w-full" onClick={handleBuy} disabled={buying}>
        {buying ? "Feeding The Claw…" : "Buy Chips"}
      </button>
    );
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Neon perspective grid background */}
      <div className="neon-grid absolute inset-0 -z-10" />
      <div
        className="absolute inset-0 -z-10"
        style={{ background: "radial-gradient(circle at 50% 30%, transparent 0%, #0a0a0f 75%)" }}
      />

      <div className="max-w-3xl mx-auto px-4 py-10 flex flex-col items-center gap-8">
        {/* The Claw + title */}
        <div className="text-center">
          <div className="text-7xl mb-2 anim-neon-pulse" aria-hidden>
            🦞
          </div>
          <h1 className="neon-text-cyan text-5xl sm:text-6xl font-black tracking-widest m-0">CLAWD BLACKJACK</h1>
          <p className="neon-text-pink text-lg mt-2">クロー・ブラックジャック</p>
        </div>

        {/* Chip Balance Card */}
        <div className="card neon-border bg-base-200 w-full max-w-md">
          <div className="card-body flex-row items-center justify-between">
            <span className="text-xs tracking-widest text-base-content/60">YOUR CHIP STACK</span>
            <span className="flex items-center gap-2 text-3xl font-bold text-cyan-400">
              <span className="text-2xl">🪙</span>
              {fmtChips(chipBalance)}
            </span>
          </div>
        </div>

        {/* Purchase section */}
        <div className="card neon-border bg-base-200 w-full max-w-md">
          <div className="card-body gap-4">
            <h2 className="neon-text-pink text-xl font-bold tracking-widest m-0 text-center">FEED THE CLAW</h2>

            <div className="join w-full">
              <button
                className={`btn join-item flex-1 ${token === "CLAWD" ? "btn-primary" : "btn-outline"}`}
                onClick={() => setToken("CLAWD")}
              >
                CLAWD
              </button>
              <button
                className={`btn join-item flex-1 ${token === "CV" ? "btn-secondary" : "btn-outline"}`}
                onClick={() => setToken("CV")}
              >
                CV
              </button>
            </div>

            <input
              type="number"
              min="0"
              placeholder={token === "CLAWD" ? "Amount of CLAWD" : "Amount of CV"}
              className="input input-bordered w-full"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={token === "CV"}
            />

            <div className="text-center text-sm text-base-content/70">
              {token === "CLAWD" && previewChips !== undefined ? (
                <span>
                  {amount} CLAWD → <span className="text-cyan-400 font-bold">{fmtChips(previewChips)}</span> chips
                </span>
              ) : token === "CV" ? (
                <span className="text-base-content/40">CV token not configured yet</span>
              ) : (
                <span className="text-base-content/40">100 CLAWD → 10,000 chips</span>
              )}
            </div>

            {renderActionButton()}
          </div>
        </div>

        {/* Claw Vault health */}
        <div className="card neon-border bg-base-200 w-full max-w-md">
          <div className="card-body flex-row items-center justify-between">
            <div>
              <div className="text-xs tracking-widest text-base-content/60">CLAW VAULT</div>
              <div className="text-accent font-semibold anim-neon-pulse">
                {clawVaultChips !== undefined && clawVaultChips > 0n ? "THE CLAW IS WELL-FED" : "THE CLAW HUNGERS"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-base-content/50">chip reserve</div>
              <div className="text-xl font-bold text-purple-400">{fmtChips(clawVaultChips)}</div>
            </div>
          </div>
        </div>

        {/* Contract info */}
        <div className="card neon-border bg-base-200 w-full max-w-md">
          <div className="card-body flex-row items-center justify-between py-3">
            <span className="text-xs tracking-widest text-base-content/50">CONTRACT</span>
            <a
              href={`https://basescan.org/address/${TABLE_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              {TABLE_ADDRESS.slice(0, 6)}…{TABLE_ADDRESS.slice(-4)}
            </a>
          </div>
        </div>

        {/* Enter the table */}
        <Link
          href="/play"
          className="btn btn-primary btn-lg w-full max-w-md text-lg tracking-widest"
          style={{ boxShadow: "0 0 24px rgba(0,245,255,0.4)" }}
        >
          ENTER THE TABLE →
        </Link>
      </div>
    </div>
  );
};

export default Lobby;
