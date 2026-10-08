"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand("copy")) throw new Error("Copy unavailable");
        textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button className="copy" type="button" onClick={copy} aria-label={`${label} ${value}`} aria-live="polite">
      {copied ? "Copied" : label}
    </button>
  );
}

const indexLinks = [
  { number: "01", label: "Overview", href: "/", state: "live", stateLabel: "live" },
  { number: "02", label: "Token", href: "/token", state: "idle", stateLabel: "unconfigured" },
  { number: "03", label: "Bridge", href: "/bridge", state: "test", stateLabel: "local test" },
  { number: "04", label: "Network", href: "/network", state: "live", stateLabel: "live" },
  { number: "05", label: "Build", href: "/build", state: "live", stateLabel: "ready" },
  { number: "06", label: "Explorer", href: "/explorer", state: "test", stateLabel: "limited" },
  { number: "07", label: "Quantum", href: "/quantum", state: "test", stateLabel: "experimental" },
  { number: "08", label: "Protocol", href: "/docs", state: "idle", stateLabel: "research" },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href.split("#")[0];
}

export function TopNavigation() {
  const pathname = usePathname();
  const links = [
    ["Overview", "/"],
    ["Bridge", "/bridge"],
    ["Network", "/network"],
    ["Build", "/build"],
    ["Quantum", "/quantum"],
    ["Docs", "/docs"],
  ] as const;
  return (
    <nav className="topnav" aria-label="Primary">
      {links.map(([label, href]) => (
        <Link key={href} href={href} aria-current={isActive(pathname, href) ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
  );
}

export function SidebarNavigation() {
  const pathname = usePathname();
  return (
    <nav className="index-rail" aria-label="Technical index">
      <div className="index-title"><span>Index</span><small>Local / 01</small></div>
      {indexLinks.map((item) => (
        <Link key={item.href} href={item.href} aria-current={isActive(pathname, item.href) ? "page" : undefined}>
          <span className="index-number">{item.number}</span>
          <span className="index-label">{item.label}</span>
          <span className={`index-state ${item.state}`} title={item.stateLabel}><i aria-hidden="true" />{item.stateLabel}</span>
        </Link>
      ))}
    </nav>
  );
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>("a,button")?.focus();
    function modalKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
      if (event.key === "Tab" && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>("a,button")];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault(); items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault(); items[0]?.focus();
        }
      }
    }
    document.addEventListener("keydown", modalKeys);
    return () => document.removeEventListener("keydown", modalKeys);
  }, [open]);

  async function copyRpc() {
    await navigator.clipboard.writeText(process.env.NEXT_PUBLIC_NATIVE_HTTP_RPC ?? "http://127.0.0.1:8899");
    setOpen(false);
  }

  return (
    <>
      <button ref={trigger} className="command-trigger" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Jump or connect <kbd>⌘K</kbd>
      </button>
      {open ? (
        <div className="palette-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <div ref={dialog} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
            <div className="palette-heading"><span>Technical index</span><button type="button" onClick={() => setOpen(false)}>Esc</button></div>
            {indexLinks.map((item) => <Link key={item.href} href={item.href} onClick={() => setOpen(false)}><b>{item.number}</b><span>{item.label}</span><small>{item.stateLabel}</small></Link>)}
            <button className="palette-action" type="button" onClick={copyRpc}><b>↗</b><span>Copy HTTP RPC</span><small>{process.env.NEXT_PUBLIC_NATIVE_HTTP_RPC ?? "127.0.0.1"}</small></button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = dialog.current?.querySelector<HTMLElement>("a");
    first?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
      if (event.key === "Tab" && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>("a,button")];
        const firstItem = focusable[0];
        const lastItem = focusable.at(-1);
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault(); lastItem?.focus();
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault(); firstItem?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="mobile-nav">
      <button
        ref={trigger}
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? (
        <div className="mobile-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <div ref={dialog} id="mobile-menu" role="dialog" aria-modal="true" aria-label="Navigation menu">
            <div className="drawer-head"><span>Network index</span><button type="button" onClick={() => setOpen(false)}>Close</button></div>
            <SidebarNavigation />
          </div>
        </div>
      ) : null}
    </div>
  );
}
