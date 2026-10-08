import { NATIVE_ENVIRONMENT_LABEL, publicConfig } from "@lattice/config";
import { readSamples } from "@lattice/bridge/state";
import Link from "next/link";
import { CopyButton } from "./components";
import { LiveRpcVitals, RpcEndpoints } from "./live-rpc";
import { fetchMarketData } from "./lib/market-data";
import { readPqEvidence } from "./lib/pq-evidence";
import { MarketPair } from "./market-pair";
import { DefinitionRow, Page, Section, Status } from "./ui";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const config = publicConfig;
  const mint = config.source.mint;
  const [samples, market, pqEvidence] = await Promise.all([
    readSamples(),
    fetchMarketData(mint, "24H"),
    readPqEvidence(),
  ]);
  return (
    <Page toc={[["Network", "#overview"], ["1:1 observations", "#tracking"], ["Asset identity", "#identity"], ["Protocol flow", "#flow"], ["Connect", "#developer"]]}>
      <header className="home-hero">
        <div className="hero-kicker"><span>Solana-derived · post-quantum research</span><i>Experimental local fork</i></div>
        <h1>The Solana fork built for the post-quantum era.</h1>
        <p>Lattice is a Solana-derived network integrating NIST FIPS 204 ML-DSA signatures in reviewable stages, alongside a native coin designed to redeem 1:1 for a configured token on Solana.</p>
        <div className="scope-tag"><i aria-hidden="true" />Post-quantum: {pqEvidence.genesisHash ? pqEvidence.status : pqEvidence.available ? "implementation partial · validator build pending" : "validator build in progress"} · full protocol protection not established</div>
        <div className="hero-pairing">
          <div><small>Production source · Solana</small><strong>{mint ? market.symbol ?? config.source.identity.symbol : "Awaiting mint"}</strong><span>{mint ? market.name ?? "Configured source token" : "Paste the Pump.fun token mint to activate"}</span></div>
          <div className="pair-symbol"><b>1</b><i>↔</i><b>1</b><small>target</small></div>
          <div><small>Native destination</small><strong>{config.project.nativeSymbol}</strong><span>Lattice · genesis live</span></div>
        </div>
        <div className="actions"><Link className="primary" href="#developer">Connect to RPC</Link><Link href="/build">Build an app</Link></div>
        <p className="hero-disclosure">Production target redemption ratio: 1:1 — bridge not active. Local charts below use isolated test assets.</p>
      </header>

      <LiveRpcVitals expectedGenesis={config.destination.genesisHash!} />

      <Link className="quantum-strip" href="/quantum">
        <span><i aria-hidden="true">Q</i><b>Post-quantum implementation</b></span>
        <strong>{pqEvidence.genesisHash ? pqEvidence.status : "Fork implementation present · runtime evidence pending"}</strong>
        <small>{pqEvidence.algorithm} · inspect evidence and classical boundaries →</small>
      </Link>

      <Section id="overview" label="Current state" title="Evidence, separated">
        <dl className="status-list">
          <DefinitionRow term="Network"><Status state="good">{NATIVE_ENVIRONMENT_LABEL} — slots advancing</Status></DefinitionRow>
          <DefinitionRow term="RPC"><Status state="good">Operational — identity verified</Status></DefinitionRow>
          <DefinitionRow term="Development bridge"><Status state="warn">Operator-attested test assets</Status></DefinitionRow>
          <DefinitionRow term="Production bridge"><Status state="neutral">Unconfigured</Status></DefinitionRow>
          <DefinitionRow term="Backing verification"><Status state="neutral">Unconfigured</Status></DefinitionRow>
          <DefinitionRow term="Quantum security"><Status state="warn">Experimental — protocol migration pending</Status></DefinitionRow>
        </dl>
      </Section>

      <Section id="tracking" label="Token ↔ Lattice" title="Market reference and redemption ledger">
        <MarketPair initialMarket={market} samples={samples} />
      </Section>

      <Section id="identity" label="Asset identity" title="Two assets, two networks">
        <div className="identity-grid">
          <article>
            <span className="label">Source asset · Solana</span>
            <h3>{config.source.identity.name}</h3>
            <p>{config.source.identity.symbol}</p>
            <div className="address"><span>{mint ?? "Not configured"}</span>{mint ? <CopyButton value={mint} /> : null}</div>
            <small>Pump.fun provenance unverified</small>
          </article>
          <div className="ratio"><span>1</span><b>↔</b><span>1</span><small>Target ratio</small></div>
          <article>
            <span className="label">Native coin · Lattice</span>
            <h3>{config.project.nativeName}</h3>
            <p>{config.project.nativeSymbol}</p>
            <div className="address">Native currency · no SPL mint</div>
            <small>Local genesis {config.destination.genesisHash?.slice(0, 8)}…</small>
          </article>
        </div>
        <p className="ratio-note">Target redemption ratio: 1:1 — bridge not active.</p>
      </Section>

      <Section id="backing" label="Backing" title="Measured facts only">
        <dl className="facts">
          <DefinitionRow term="Backing asset">Not configured</DefinitionRow>
          <DefinitionRow term="Source mint">Not configured</DefinitionRow>
          <DefinitionRow term="Reserve vault">Not configured</DefinitionRow>
          <DefinitionRow term="Native supply">Unavailable</DefinitionRow>
          <DefinitionRow term="Outstanding claims">Unavailable</DefinitionRow>
          <DefinitionRow term="Backing coverage">Unavailable</DefinitionRow>
          <DefinitionRow term="Checked at">Never</DefinitionRow>
          <DefinitionRow term="Native genesis hash">Not configured</DefinitionRow>
        </dl>
        <div className="actions"><Link className="primary" href="/token">Inspect token &amp; backing</Link><Link href="/bridge">View bridge</Link></div>
      </Section>

      <Section id="flow" label="Protocol flow" title="Lock, issue, redeem">
        <div className="steps">
          <article><b>01</b><h3>Lock</h3><p>A source-vault instruction records the destination and actual credited amount.</p></article>
          <article><b>02</b><h3>Issue</h3><p>A finalized, unconsumed receipt authorizes exact native issuance.</p></article>
          <article><b>03</b><h3>Redeem</h3><p>An atomic native burn creates a durable source payout receipt.</p></article>
        </div>
      </Section>

      <Section id="developer" label="Developers" title="Local access, clearly labeled">
        <p>The configured endpoints are live on this machine. They are not reachable by developers on other computers until a hosted TLS gateway exists.</p>
        <RpcEndpoints />
        <div className="actions"><Link className="primary" href="/build">Build an app</Link><Link href="/network">Inspect RPC status</Link></div>
      </Section>
    </Page>
  );
}
