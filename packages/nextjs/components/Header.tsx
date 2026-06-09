"use client";

import Link from "next/link";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";

export const Header = () => {
  return (
    <header className="sticky top-0 z-50 border-b border-cyan-500/30 bg-base-100/90 backdrop-blur-md">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 group">
          <span className="text-2xl">🦞</span>
          <div>
            <div className="font-bold text-cyan-400 text-lg leading-tight" style={{ textShadow: "0 0 10px #00f5ff" }}>
              CLAWD Blackjack
            </div>
            <div className="text-xs text-pink-400/70">Neon Tokyo</div>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-6">
          <Link href="/" className="text-sm text-base-content/70 hover:text-cyan-400 transition-colors">
            Lobby
          </Link>
          <Link href="/play" className="text-sm text-base-content/70 hover:text-cyan-400 transition-colors">
            The Table
          </Link>
        </nav>
        <RainbowKitCustomConnectButton />
      </div>
    </header>
  );
};
