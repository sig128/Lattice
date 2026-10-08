import type { ReactNode } from "react";

export function Page({
  children,
  toc,
}: {
  children: ReactNode;
  toc: readonly [string, string][];
}) {
  return (
    <div className="page-grid">
      <main id="main-content">{children}</main>
      <aside className="toc" aria-label="On this page">
        <p>On this page</p>
        {toc.map(([label, href]) => <a key={href} href={href}>{label}</a>)}
      </aside>
    </div>
  );
}

export function PageHeader({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="eyebrow">{label} <span>Local development</span></div>
      <h1>{title}</h1>
      <div className="lede">{children}</div>
    </header>
  );
}

export function Status({
  state,
  children,
}: {
  state: "good" | "warn" | "bad" | "neutral";
  children: ReactNode;
}) {
  return <span className={`status ${state}`}><i aria-hidden="true" />{children}</span>;
}

export function DefinitionRow({ term, children }: { term: string; children: ReactNode }) {
  return <div className="definition-row"><dt>{term}</dt><dd>{children}</dd></div>;
}

export function Code({ children }: { children: string }) {
  return <pre tabIndex={0}><code>{children}</code></pre>;
}

export function Section({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id}>
      {label ? <div className="eyebrow">{label}</div> : null}
      <h2>{title}</h2>
      {children}
    </section>
  );
}
