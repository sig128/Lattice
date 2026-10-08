import { Code, DefinitionRow, Page, PageHeader, Section, Status } from "../ui";

export default function DocsPage() {
  return (
    <Page toc={[["Protocol", "#protocol"], ["Economics", "#economics"], ["Trust", "#trust"], ["Capabilities", "#capabilities"], ["Quantum", "#quantum"], ["Run a node", "#node"]]}>
      <PageHeader label="Documentation" title="Protocol scope and evidence">
        <p>This documentation distinguishes implemented foundations from future chain, bridge, and security work. A polished interface is not launch readiness.</p>
      </PageHeader>

      <Section id="protocol" label="Protocol" title="Lock, issue, burn, release">
        <p>A valid source deposit must be finalized, domain-bound, and previously unconsumed before native issuance. A withdrawal must atomically destroy redeemable native supply and create a durable receipt bound to the source recipient.</p>
        <Code>{`deposit: source lock → finalized receipt → native issue
withdrawal: native burn → durable receipt → source release

event identity = transaction + instruction index + event index
consumption = atomic and persisted on-chain`}</Code>
      </Section>

      <Section id="economics" label="Economics" title="Backing includes every redeemable liability">
        <Code>{`R = spendable source reserves in the designated vault
N = all outstanding redeemable native supply
P = finalized source deposits owed credit or approved refund
W = finalized native burns owed a source payout
L = N + P + W

required backing: R >= L`}</Code>
        <p>Watermarks must be comparable and fresh. Zero liabilities display “No outstanding claims,” never an invented coverage percentage. Pending claims cannot be omitted to improve the ratio.</p>
      </Section>

      <Section id="trust" label="Trust assumptions" title="Development attestation is not trustless">
        <ul className="check-list">
          <li>The first local bridge may use a controlled operator signer.</li>
          <li>The signer set, threshold, epoch, rotation, domains, and exact message must be enforced by destination state.</li>
          <li>Multiple RPCs detect disagreement; they are not cryptographic finality proofs.</li>
          <li>Reserve balances alone do not prove liabilities or establish a security audit.</li>
        </ul>
      </Section>

      <Section id="capabilities" label="Capability matrix" title="Compatibility is explicit">
        <dl className="facts">
          <DefinitionRow term="Configuration and manifest"><Status state="good">Implemented</Status></DefinitionRow>
          <DefinitionRow term="Exact amount / reconciliation"><Status state="good">Implemented and tested</Status></DefinitionRow>
          <DefinitionRow term="Live local RPC probe"><Status state="good">Implemented</Status></DefinitionRow>
          <DefinitionRow term="Independent local genesis"><Status state="good">Agave 4.3.0 · RPC and slots live</Status></DefinitionRow>
          <DefinitionRow term="Native transfer"><Status state="good">Verified through runnable example</Status></DefinitionRow>
          <DefinitionRow term="Program deployment"><Status state="warn">Host Xcode toolchain blocked</Status></DefinitionRow>
          <DefinitionRow term="Source vault / native issue-burn"><Status state="neutral">Not implemented</Status></DefinitionRow>
          <DefinitionRow term="Public RPC / explorer history"><Status state="neutral">Not deployed</Status></DefinitionRow>
        </dl>
      </Section>

      <Section id="quantum" label="Quantum research" title="Experimental — full protocol protection not established">
        <dl className="facts">
          <DefinitionRow term="ML-DSA-65 prototype"><Status state="good">Off-chain sign / verify implemented</Status></DefinitionRow>
          <DefinitionRow term="Measured locally">1,952 B public key · 3,309 B signature · 8.57 ms sign · 1.70 ms verify</DefinitionRow>
          <DefinitionRow term="Native authorization">Classical</DefinitionRow>
          <DefinitionRow term="Consensus / networking">Classical</DefinitionRow>
          <DefinitionRow term="Bridge / upgrades">Classical or unconfigured</DefinitionRow>
          <DefinitionRow term="Independent review">None</DefinitionRow>
        </dl>
        <p>The Solana token, settlement, source wallets, and custody can remain vulnerable even if the destination protocol changes. Bridging does not make the Solana representation quantum resistant.</p>
      </Section>

      <Section id="node" label="Run a node" title="Pinned Agave baseline">
        <Code>{`./chain/scripts/fetch-upstream.sh
# Build the exact checkout following its release instructions.
./chain/scripts/start-local.sh --reset
solana --url http://127.0.0.1:8899 genesis-hash`}</Code>
        <p>Agave v4.3.0 is pinned at commit <code>825efd18292aff6ffcf9daa0f7612f21b3531a72</code>. The local faucet is unbacked test money.</p>
      </Section>
    </Page>
  );
}
