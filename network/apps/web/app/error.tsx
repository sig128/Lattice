"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page-grid">
      <main id="main-content">
        <header className="page-header">
          <div className="eyebrow">Error</div>
          <h1>Evidence could not be loaded</h1>
          <div className="error-state">
            <p>{error.message || "An unexpected error occurred."}</p>
            <button className="primary" type="button" onClick={reset}>Try again</button>
          </div>
        </header>
      </main>
    </div>
  );
}
