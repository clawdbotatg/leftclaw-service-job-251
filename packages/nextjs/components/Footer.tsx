export const Footer = () => {
  return (
    <footer className="border-t border-cyan-500/20 bg-base-100/50 py-4 mt-auto">
      <div className="max-w-6xl mx-auto px-4 flex items-center justify-between text-xs text-base-content/40">
        <span>CLAWD Blackjack — Neon Tokyo</span>
        <span>
          Deployed on{" "}
          <a href="https://base.org" target="_blank" rel="noreferrer" className="hover:text-cyan-400 transition-colors">
            Base
          </a>
        </span>
      </div>
    </footer>
  );
};
