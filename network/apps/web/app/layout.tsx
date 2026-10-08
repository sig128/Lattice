import type { Metadata } from "next";
import { NATIVE_ENVIRONMENT_LABEL, publicConfig } from "@lattice/config";
import { CommandPalette, MobileNavigation, SidebarNavigation, TopNavigation } from "./components";
import { VoxelMark } from "./voxel-mark";
import "./styles.css";

export const metadata: Metadata = {
  title: "Lattice",
  description: "A Solana-derived network integrating post-quantum ML-DSA authorization in reviewable stages.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <header className="topbar">
          <VoxelMark />
          <TopNavigation />
          <CommandPalette />
          <span className="environment">{NATIVE_ENVIRONMENT_LABEL}</span>
          <a className="social-x" href="https://x.com/sig128" target="_blank" rel="noopener noreferrer" aria-label="Lattice on X (opens in a new tab)">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <MobileNavigation />
        </header>
        <div className="site-shell">
          <aside className="sidebar"><SidebarNavigation /></aside>
          {children}
        </div>
      </body>
    </html>
  );
}
