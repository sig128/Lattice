import { publicConfig } from "@lattice/config";
import { CopyButton } from "../components";
import { fetchMarketData } from "../lib/market-data";
import { DefinitionRow, Page, PageHeader, Section, Status } from "../ui";

export const dynamic = "force-dynamic";

export default async function TokenPage() {
  const { source } = publicConfig;
  const market = await fetchMarketData(source.mint, "24H");
  return (
    <Page toc={[["Identity", "#identity"], ["Backing", "#backing"], ["Validation", "#validation"], ["Provenance", "#provenance"]]}>
      <PageHeader label="Token & backing" title="Canonical identity, inspectable reserves">
        <p>The exact Solana mint address defines the source asset. Display names, symbols, images, websites, and suffixes are untrusted metadata.</p>
      </PageHeader>

      <Section id="identity" label="Source identity" title="Production asset unconfigured">
        <dl className="facts">
          <DefinitionRow term="Source network">Solana mainnet</DefinitionRow>
          <DefinitionRow term="Expected genesis"><span className="mono">{source.expectedGenesisHash}</span></DefinitionRow>
          <DefinitionRow term="Display identity">{source.mint ? `${market.name ?? source.identity.name}${market.symbol ? ` · ${market.symbol}` : ""}` : "Awaiting token mint"}</DefinitionRow>
          <DefinitionRow term="Mint">{source.mint ? <span className="inline-copy"><code>{source.mint}</code><CopyButton value={source.mint} /></span> : "Not configured"}</DefinitionRow>
          <DefinitionRow term="Token program">Not configured</DefinitionRow>
          <DefinitionRow term="Decimals">Unavailable</DefinitionRow>
          <DefinitionRow term="Pump.fun provenance"><Status state="warn">Unverified</Status></DefinitionRow>
          <DefinitionRow term="Market data">{market.source ? `${market.source} · ${market.points.length} observations` : source.mint ? market.error ?? "Unavailable" : "Awaiting mint"}</DefinitionRow>
        </dl>
      </Section>

      <Section id="backing" label="Reserve evidence" title="No vault, no coverage claim">
        <dl className="facts">
          <DefinitionRow term="Designated vault">Not configured</DefinitionRow>
          <DefinitionRow term="Spendable reserves (R)">Unavailable</DefinitionRow>
          <DefinitionRow term="Redeemable native supply (N)">Unavailable</DefinitionRow>
          <DefinitionRow term="Pending deposits (P)">Unavailable</DefinitionRow>
          <DefinitionRow term="Pending withdrawals (W)">Unavailable</DefinitionRow>
          <DefinitionRow term="Liabilities (N + P + W)">Unavailable</DefinitionRow>
          <DefinitionRow term="Observed coverage">Unavailable</DefinitionRow>
          <DefinitionRow term="Comparable watermark">No observations</DefinitionRow>
        </dl>
        <p className="caption">A wallet, treasury, or liquidity pool balance is not bridge backing unless the specified redemption mechanism controls it.</p>
      </Section>

      <Section id="validation" label="Validation" title="What must pass">
        <ul className="check-list">
          <li>Valid public key and initialized mint account on the expected genesis.</li>
          <li>Legacy SPL Token or explicitly supported Token-2022 program ownership.</li>
          <li>On-chain decimals, supply, authorities, and extension state inspected.</li>
          <li>Transfer fees, hooks, confidential transfers, nontransferability, permanent delegates, and scaling semantics rejected.</li>
          <li>Metadata treated as untrusted text and fetched only through SSRF-safe policy.</li>
        </ul>
      </Section>

      <Section id="provenance" label="Provenance" title="Fetched does not mean verified">
        <p>Pump.fun provenance requires creation evidence from the current official program. A successful account fetch alone does not establish where a token launched.</p>
      </Section>
    </Page>
  );
}
