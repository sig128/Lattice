import { NATIVE_ENVIRONMENT_LABEL, publicConfig } from "@lattice/config";
import { CopyButton } from "../components";
import { Faucet, RpcConsole } from "../live-rpc";
import { Code, DefinitionRow, Page, PageHeader, Section, Status } from "../ui";

export default function BuildPage() {
  const rpc = publicConfig.rpc[0]!;
  return (
    <Page toc={[["Quickstart", "#quickstart"], ["Connect", "#connect"], ["Try RPC", "#console"], ["Test funds", "#faucet"], ["Transfer", "#transfer"], ["Programs", "#programs"], ["Compatibility", "#compatibility"]]}>
      <PageHeader label="Build" title="Connect with network identity first">
        <p>The developer path begins by reading the manifest and verifying the RPC genesis. Local tooling remains standard Agave until protocol changes are introduced.</p>
      </PageHeader>

      <Section id="quickstart" label="Quickstart" title="A verifiable development loop">
        <ol className="quickstart">
          <li><b>Read the manifest</b><span>Verify the destination genesis is configured.</span></li>
          <li><b>Start the validator</b><span>Use the pinned Agave baseline and persistent local ledger.</span></li>
          <li><b>Check identity</b><span>Reject a missing or mismatched genesis before signing.</span></li>
          <li><b>Use test funds</b><span>Local faucet units are unbacked and can never become production units.</span></li>
          <li><b>Submit and confirm</b><span>Use the actual supported transaction format and finalized commitment.</span></li>
        </ol>
      </Section>

      <Section id="connect" label="Connect" title="Manifest and RPC">
        <div className="endpoint-line"><code>{rpc.httpUrl}</code><CopyButton value={rpc.httpUrl} /></div>
        <Code>{`import { Connection } from "@solana/web3.js";

const manifest = await fetch("/api/network-manifest").then(r => r.json());
if (!manifest.destination.genesisHash) throw new Error("Network not configured");

const connection = new Connection("${rpc.httpUrl}", "finalized");
const observed = await connection.getGenesisHash();
if (observed !== manifest.destination.genesisHash) throw new Error("Wrong network");`}</Code>
      </Section>

      <Section id="console" label="Try it" title="Run an allowlisted RPC read">
        <p>This console calls the configured local endpoint through a bounded server route. It cannot probe arbitrary hosts or submit transactions.</p>
        <RpcConsole />
      </Section>

      <Section id="faucet" label="Development faucet" title="Obtain local test units">
        <p>These units are unbacked, exist only on this local genesis, and can never become production units.</p>
        <Faucet />
      </Section>

      <Section id="transfer" label="Native transfer" title="Milestone pending">
        <dl className="facts">
          <DefinitionRow term="Transaction format"><Status state="good">Standard Agave transfer verified locally</Status></DefinitionRow>
          <DefinitionRow term="Native decimals">{publicConfig.project.nativeDecimals}</DefinitionRow>
          <DefinitionRow term="Fee behavior">Unavailable until validator configuration exists</DefinitionRow>
          <DefinitionRow term="Faucet">Operational · {NATIVE_ENVIRONMENT_LABEL.toLowerCase()} · unbacked test units · rate-limited</DefinitionRow>
          <DefinitionRow term="Runnable example"><code>pnpm --filter @lattice/example-native-transfer start</code></DefinitionRow>
          <DefinitionRow term="Wallet support">CLI / SDK works; browser wallet compatibility unverified</DefinitionRow>
        </dl>
      </Section>

      <Section id="programs" label="SVM programs" title="Example deployment pending">
        <p>The pinned, unmodified Agave baseline should support standard SVM programs, but an external counter app has not yet been deployed and called through this repository&apos;s RPC.</p>
        <Code>{`# Against this network's public RPC:
solana --url ${rpc.httpUrl} genesis-hash
solana --url ${rpc.httpUrl} slot
# Program build/deploy commands will be pinned with the example.`}</Code>
      </Section>

      <Section id="compatibility" label="Compatibility" title="Do not assume every Solana app works">
        <p>Future native issuance and post-quantum framing may affect SDKs, wallets, transaction limits, hardware signers, and validator interoperability. No MetaMask or Phantom compatibility is claimed.</p>
      </Section>
    </Page>
  );
}
