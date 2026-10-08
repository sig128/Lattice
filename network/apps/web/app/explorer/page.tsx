import { DefinitionRow, Page, PageHeader, Section, Status } from "../ui";

export default function ExplorerPage() {
  return (
    <Page toc={[["Search", "#search"], ["Coverage", "#coverage"]]}>
      <PageHeader label="Explorer" title="Inspect the development ledger">
        <p>Slots, transactions, accounts, supply, and bridge receipts will appear only when a matching network and indexer provide real evidence.</p>
      </PageHeader>

      <Section id="search" label="Search" title="Ledger unavailable">
        <div className="empty-state">
          <span className="empty-mark" aria-hidden="true">⌁</span>
          <h3>No matching network observation</h3>
          <p>An indexer for this genesis is not running yet; use the RPC directly until it is.</p>
          <label className="search">Slot, transaction, account, or receipt<input disabled placeholder="Explorer unavailable" /></label>
        </div>
      </Section>

      <Section id="coverage" label="Index coverage" title="No fictional history">
        <dl className="facts">
          <DefinitionRow term="Finalized slot"><Status state="bad">Unavailable</Status></DefinitionRow>
          <DefinitionRow term="Oldest indexed slot">Unavailable</DefinitionRow>
          <DefinitionRow term="Transactions">Unavailable</DefinitionRow>
          <DefinitionRow term="Native supply">Unavailable</DefinitionRow>
          <DefinitionRow term="Bridge receipts">Unavailable</DefinitionRow>
          <DefinitionRow term="Pruned history">Unknown</DefinitionRow>
        </dl>
      </Section>
    </Page>
  );
}
