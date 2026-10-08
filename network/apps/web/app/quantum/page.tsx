import { CopyButton } from "../components";
import { readPqEvidence } from "../lib/pq-evidence";
import { DefinitionRow, Page, PageHeader, Section, Status } from "../ui";

export const dynamic = "force-dynamic";

export default async function QuantumPage() {
  const evidence = await readPqEvidence();
  const measurements = Object.entries(evidence.measurements);
  return (
    <Page toc={[["Evidence", "#evidence"], ["Protected now", "#protected"], ["Still classical", "#classical"], ["Measurements", "#measurements"], ["External boundary", "#boundary"]]}>
      <PageHeader label="Post-quantum implementation" title="ML-DSA, enforced in reviewable increments">
        <p>Lattice researches NIST FIPS 204 ML-DSA signatures on a Solana-derived fork. Protection is reported per authorization surface; the network is not described as universally post-quantum secure.</p>
      </PageHeader>

      <div className={`quantum-state ${evidence.available ? "available" : "building"}`}>
        <span>{evidence.available ? "Evidence loaded" : "Build status"}</span>
        <strong>{evidence.status}</strong>
        <small>{evidence.algorithm}</small>
      </div>

      <Section id="evidence" label="Local fork evidence" title={evidence.genesisHash ? "Observed runtime evidence" : evidence.available ? "Implementation evidence · runtime pending" : "Validator build in progress"}>
        {evidence.statusDetail ? <div className="notice"><strong>Current boundary</strong>{evidence.statusDetail}</div> : null}
        <dl className="facts">
          <DefinitionRow term="Algorithm">{evidence.algorithm}</DefinitionRow>
          <DefinitionRow term="PQ genesis">{evidence.genesisHash ?? "Pending evidence"}</DefinitionRow>
          <DefinitionRow term="PQ validator RPC">{evidence.httpRpc ?? "Pending evidence · reserved local port 8999"}</DefinitionRow>
          <DefinitionRow term="Verifier / vault program">{evidence.programId ?? "Pending deployment evidence"}</DefinitionRow>
          <DefinitionRow term="Checked at">{evidence.checkedAt ?? "Not available yet"}</DefinitionRow>
        </dl>
        {evidence.transactions.length ? (
          <div className="evidence-transactions">
            <h3>Sample transactions</h3>
            {evidence.transactions.map((signature) => <div key={signature}><code>{signature}</code><CopyButton value={signature} /></div>)}
          </div>
        ) : <p className="caption">No PQ validator transaction signature has been published yet.</p>}
      </Section>

      <Section id="protected" label="Implementation map" title="Protected now">
        <ul className="scope-map protected">
          {(evidence.protectedNow.length ? evidence.protectedNow : ["Evidence pending"]).map((item) => <li key={item}><Status state="good">Implemented scope</Status><span>{item}</span></li>)}
        </ul>
      </Section>

      <Section id="classical" label="Implementation map" title="Still classical">
        <ul className="scope-map classical">
          {evidence.stillClassical.map((item) => <li key={item}><Status state="warn">Classical</Status><span>{item}</span></li>)}
        </ul>
      </Section>

      <Section id="measurements" label="Measurements" title="Measured, not inferred">
        {measurements.length ? (
          <dl className="facts">{measurements.map(([name, value]) => <DefinitionRow key={name} term={name}>{String(value)}</DefinitionRow>)}</dl>
        ) : (
          <dl className="facts">
            <DefinitionRow term="Off-chain prototype public key">1,952 bytes</DefinitionRow>
            <DefinitionRow term="Off-chain prototype signature">3,309 bytes</DefinitionRow>
            <DefinitionRow term="Off-chain prototype mean signing">8.57 ms</DefinitionRow>
            <DefinitionRow term="Off-chain prototype mean verification">1.70 ms</DefinitionRow>
          </dl>
        )}
        <p className="caption">Prototype measurements do not establish native transaction or consensus protection.</p>
      </Section>

      <Section id="boundary" label="External boundary" title="A bridge does not upgrade Solana">
        <p>The source token, Solana settlement, source wallet signatures, and bridge custody remain separate security surfaces. Post-quantum authorization on the Lattice fork does not make the Solana representation post-quantum protected.</p>
      </Section>
    </Page>
  );
}
