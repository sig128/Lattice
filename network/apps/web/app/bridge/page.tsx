import { readSamples, readState } from "@lattice/bridge/state";
import Link from "next/link";
import { DefinitionRow, Page, PageHeader, Section, Status } from "../ui";
import { LocalBridge } from "./local-bridge";

export const dynamic = "force-dynamic";

export default async function BridgePage() {
  const [localState, samples] = await Promise.all([readState(), readSamples()]);
  const latest = samples.at(-1);
  return (
    <Page toc={[["Availability", "#availability"], ["Conversion", "#conversion"], ["Progress states", "#progress"], ["Trust model", "#trust"]]}>
      <PageHeader label="Bridge" title="Move value with verifiable receipts">
        <p>The production bridge remains unconfigured. A separate operator-attested local demonstration is active with isolated SPL test assets.</p>
      </PageHeader>

      <Section id="availability" label="Availability" title="Local demonstration operational">
        <dl className="facts">
          <DefinitionRow term="Local test deposits"><Status state="good">Executed on local ledger</Status></DefinitionRow>
          <DefinitionRow term="Local test redemption"><Status state="good">Executed on local ledger</Status></DefinitionRow>
          <DefinitionRow term="Source test mint"><code>{localState?.sourceMint ?? "Unavailable"}</code></DefinitionRow>
          <DefinitionRow term="Vault account"><code>{localState?.vaultAccount ?? "Unavailable"}</code></DefinitionRow>
          <DefinitionRow term="Issued bridge test asset"><code>{localState?.issuedMint ?? "Unavailable"}</code></DefinitionRow>
          <DefinitionRow term="Observed coverage">{latest?.label ?? "Collecting history"}</DefinitionRow>
          <DefinitionRow term="Production target">1:1 — bridge not active</DefinitionRow>
        </dl>
      </Section>

      <Section id="conversion" label="Local bridge" title="Lock, issue, burn, redeem">
        <LocalBridge />
        <p className="caption">The browser creates an isolated local development key and never requests a seed phrase. Production deposits remain disabled even when a display mint is configured.</p>
      </Section>

      <Section id="progress" label="Receipts" title="Resumable transaction progress">
        <ol className="progress-list">
          {["Awaiting signature", "Submitted", "Awaiting finality", "Processing", "Completed"].map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
        </ol>
        <p>Completed local claims retain a receipt identifier in browser storage and durable server state, with separate source and destination transaction signatures.</p>
      </Section>

      <Section id="trust" label="Trust model" title="Operator-attested development bridge">
        <p>The planned first local deployment uses a controlled signer and is not trustless. Production requires a reviewed proof or threshold signer model, source finality rules, domain separation, replay protection, signer rotation, and independent pause controls.</p>
        <div className="actions"><Link href="/docs#trust">Read trust assumptions</Link><Link href="/token">Inspect backing fields</Link></div>
      </Section>
    </Page>
  );
}
