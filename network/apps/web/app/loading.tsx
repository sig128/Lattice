export default function Loading() {
  return (
    <div className="page-grid">
      <main id="main-content" aria-busy="true" aria-live="polite">
        <header className="page-header">
          <div className="eyebrow">Loading</div>
          <h1>Checking current state</h1>
          <p className="lede">Reading configured evidence without substituting cached or fictional values.</p>
          <div className="loading-lines" aria-hidden="true"><span /><span /><span /></div>
        </header>
      </main>
    </div>
  );
}
