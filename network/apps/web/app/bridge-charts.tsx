import type { BridgeSample } from "@lattice/bridge/state";

function chartPoints(values: number[]) {
  const width = 420;
  const height = 132;
  const max = Math.max(...values, 1);
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - (value / max) * (height - 22) - 8;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function LineChart({
  title,
  values,
  latest,
  description,
}: {
  title: string;
  values: number[];
  latest: number;
  description: string;
}) {
  return (
    <article className="line-chart">
      <header><div><span>{title}</span><small>{description}</small></div><strong>{latest.toLocaleString()} <i>units</i></strong></header>
      <svg viewBox="0 0 420 150" role="img" aria-label={`${title}: ${latest} local test units`}>
        <title>{title}</title>
        <desc>Observed values: {values.join(", ")}</desc>
        <line x1="0" y1="142" x2="420" y2="142" />
        <line x1="0" y1="82" x2="420" y2="82" />
        <line x1="0" y1="22" x2="420" y2="22" />
        <polyline points={chartPoints(values)} />
        {values.map((value, index) => {
          const [x, y] = chartPoints(values).split(" ")[index]!.split(",");
          return <circle key={`${index}-${value}`} cx={x} cy={y} r="3" />;
        })}
      </svg>
      <footer><span>Initial</span><span>Latest observed</span></footer>
    </article>
  );
}

export function BridgeCharts({ samples, decimals }: { samples: BridgeSample[]; decimals: number }) {
  if (samples.length === 0) return <div className="chart-empty">Collecting history</div>;
  const divisor = 10 ** decimals;
  const reserves = samples.map((sample) => Number(BigInt(sample.reservesAtomic)) / divisor);
  const liabilities = samples.map((sample) => Number(BigInt(sample.liabilitiesAtomic)) / divisor);
  const latest = samples.at(-1)!;
  return (
    <div>
      <div className="chart-meta">
        <span>Local development · test assets · not real backing</span>
        <strong>Observed coverage {latest.label}</strong>
      </div>
      <div className="chart-pair">
        <LineChart title="Vault reserves · R" values={reserves} latest={reserves.at(-1)!} description="Local SPL source test asset" />
        <LineChart title="Issued + pending · L" values={liabilities} latest={liabilities.at(-1)!} description="Bridge test asset liabilities" />
      </div>
      <p className="caption">Recorded from finalized local ledger observations at slots {samples[0]!.slot.toLocaleString()}–{latest.slot.toLocaleString()}. Series: {samples.map((sample) => sample.trigger).join(" → ")}.</p>
    </div>
  );
}
