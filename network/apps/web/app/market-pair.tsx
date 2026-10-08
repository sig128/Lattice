"use client";

import { NATIVE_ENVIRONMENT_LABEL } from "@lattice/config/network";
import type { BridgeSample } from "@lattice/bridge/state";
import { useMemo, useRef, useState } from "react";
import { CopyButton } from "./components";
import type { MarketData, MarketInterval, MarketPoint, MarketRange } from "./lib/market-data";

const WIDTH = 560;
const HEIGHT = 260;
const LEFT = 12;
const RIGHT = 67;
const PRICE_TOP = 18;
const PRICE_BOTTOM = 178;
const VOLUME_TOP = 190;
const VOLUME_BOTTOM = 230;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;

function formatUsd(value: number | null) {
  if (value === null) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 5 })}`;
  return `$${value.toLocaleString(undefined, { maximumSignificantDigits: 5 })}`;
}

function formatCompact(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
}

function lineCoordinates(values: number[], top = PRICE_TOP, bottom = PRICE_BOTTOM) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max, 1);
  return values.map((value, index) => ({
    x: LEFT + ((index + 0.5) / values.length) * PLOT_WIDTH,
    y: bottom - ((value - min) / span) * (bottom - top),
  }));
}

function polyline(points: Array<{ x: number; y: number }>) {
  return points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

function EmptyTradingFrame({ configured, error }: { configured: boolean; error: string | null }) {
  return (
    <div className="trading-empty">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
        {[PRICE_TOP, 72, 126, PRICE_BOTTOM, VOLUME_BOTTOM].map((y) => <line key={y} x1={LEFT} y1={y} x2={WIDTH - RIGHT} y2={y} />)}
        {[LEFT, 130, 248, 366, WIDTH - RIGHT].map((x) => <line key={x} x1={x} y1={PRICE_TOP} x2={x} y2={VOLUME_BOTTOM} />)}
      </svg>
      <div><strong>{configured ? "Market history unavailable" : "Awaiting token mint"}</strong><span>{configured ? error : "Paste NEXT_PUBLIC_SOURCE_TOKEN_MINT to load real candles. No placeholder prices are drawn."}</span></div>
    </div>
  );
}

function TokenTradingChart({
  market,
  loading,
  display,
  onDisplay,
  onRange,
  onInterval,
}: {
  market: MarketData;
  loading: boolean;
  display: "candles" | "line";
  onDisplay: (display: "candles" | "line") => void;
  onRange: (range: MarketRange) => void;
  onInterval: (interval: MarketInterval) => void;
}) {
  const [windowSize, setWindowSize] = useState(80);
  const [offset, setOffset] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  const visible = useMemo(() => {
    const count = Math.min(windowSize, market.points.length);
    const maxOffset = Math.max(0, market.points.length - count);
    const start = Math.max(0, maxOffset - Math.min(offset, maxOffset));
    return market.points.slice(start, start + count);
  }, [market.points, offset, windowSize]);
  const prices = visible.flatMap((point) => [point.high, point.low]);
  const min = prices.length ? Math.min(...prices) : 0;
  const max = prices.length ? Math.max(...prices) : 1;
  const span = max - min || Math.max(max, 1);
  const volumeMax = Math.max(...visible.map((point) => point.volume), 1);
  const candleWidth = Math.max(1.6, Math.min(8, (PLOT_WIDTH / Math.max(visible.length, 1)) * 0.65));
  const x = (index: number) => LEFT + ((index + 0.5) / Math.max(visible.length, 1)) * PLOT_WIDTH;
  const y = (price: number) => PRICE_BOTTOM - ((price - min) / span) * (PRICE_BOTTOM - PRICE_TOP);
  const selected = active === null ? visible.at(-1) : visible[active];
  const current = market.currentPriceUsd;

  function selectFromPointer(event: React.PointerEvent<SVGSVGElement>) {
    if (!visible.length) return;
    if (drag.current) {
      const step = PLOT_WIDTH / visible.length;
      setOffset(Math.max(0, drag.current.offset + Math.round((event.clientX - drag.current.x) / step)));
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    setActive(Math.max(0, Math.min(visible.length - 1, Math.floor(((chartX - LEFT) / PLOT_WIDTH) * visible.length))));
  }

  function keyboard(event: React.KeyboardEvent<SVGSVGElement>) {
    if (!visible.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") return setActive(0);
    if (event.key === "End") return setActive(visible.length - 1);
    setActive((index) => Math.max(0, Math.min(visible.length - 1, (index ?? visible.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  }

  return (
    <article className="terminal-card">
      <header className="terminal-header">
        <div className="asset-heading"><span className="asset-mark">{market.symbol?.slice(0, 2) ?? "—"}</span><div><small>Solana pool</small><h3>{market.configured ? `${market.symbol ?? "TOKEN"} / ${market.quoteSymbol ?? "SOL"}` : "TOKEN / SOL"}</h3><p>{market.name ?? "Awaiting token mint"}</p></div></div>
        <div className="terminal-price"><strong>{formatUsd(current)}</strong><span className={(market.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{market.changePercent === null ? "—" : `${market.changePercent >= 0 ? "+" : ""}${market.changePercent.toFixed(2)}% 24h`}</span></div>
      </header>
      <div className="terminal-stats">
        <div><span>24h volume</span><strong>{formatUsd(market.volume24hUsd)}</strong></div>
        <div><span>Liquidity</span><strong>{formatUsd(market.liquidityUsd)}</strong></div>
        <div><span>Market cap</span><strong>{formatUsd(market.marketCapUsd)}</strong></div>
        <div><span>FDV</span><strong>{formatUsd(market.fdvUsd)}</strong></div>
        <div className="pool-stat"><span>Pool</span><code>{market.poolAddress ? `${market.poolAddress.slice(0, 5)}…${market.poolAddress.slice(-4)}` : "—"}</code>{market.poolAddress ? <CopyButton value={market.poolAddress} /> : null}</div>
      </div>
      <div className="terminal-tools">
        <div className="interval-tabs">{(["1m", "5m", "15m", "1h", "4h", "1D"] as const).map((interval) => <button key={interval} className={market.interval === interval ? "active" : ""} onClick={() => onInterval(interval)} disabled={loading}>{interval}</button>)}</div>
        <div className="display-toggle"><button className={display === "candles" ? "active" : ""} onClick={() => onDisplay("candles")}>Candles</button><button className={display === "line" ? "active" : ""} onClick={() => onDisplay("line")}>Line</button></div>
        <div className="range-tabs">{(["24H", "7D", "30D"] as const).map((range) => <button key={range} className={market.range === range ? "active" : ""} onClick={() => onRange(range)} disabled={loading}>{range}</button>)}</div>
      </div>
      {visible.length > 1 ? (
        <>
          <div className="ohlcv-readout" aria-live="polite">
            <span>O <b>{formatUsd(selected?.open ?? null)}</b></span><span>H <b>{formatUsd(selected?.high ?? null)}</b></span><span>L <b>{formatUsd(selected?.low ?? null)}</b></span><span>C <b>{formatUsd(selected?.close ?? null)}</b></span><span>V <b>{formatCompact(selected?.volume ?? null)}</b></span>
            <span className={(selected?.close ?? 0) >= (selected?.open ?? 0) ? "positive" : "negative"}>{selected ? `${(((selected.close - selected.open) / selected.open) * 100).toFixed(2)}%` : ""}</span>
          </div>
          <svg className="trading-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0} aria-label={`${market.symbol ?? "Token"} candlestick chart. Arrow keys move the crosshair; mouse wheel zooms; drag pans.`}
            onPointerMove={selectFromPointer} onPointerLeave={() => { setActive(null); drag.current = null; }} onPointerDown={(event) => { drag.current = { x: event.clientX, offset }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerUp={() => { drag.current = null; }} onKeyDown={keyboard}
            onWheel={(event) => { event.preventDefault(); setWindowSize((size) => Math.max(10, Math.min(market.points.length, size + (event.deltaY > 0 ? 8 : -8)))); }}>
            <title>{market.symbol ?? "Configured token"} OHLCV</title>
            {[PRICE_TOP, 72, 126, PRICE_BOTTOM, VOLUME_BOTTOM].map((gridY) => <line className="grid" key={gridY} x1={LEFT} y1={gridY} x2={WIDTH - RIGHT} y2={gridY} />)}
            {[LEFT, 130, 248, 366, WIDTH - RIGHT].map((gridX) => <line className="grid" key={gridX} x1={gridX} y1={PRICE_TOP} x2={gridX} y2={VOLUME_BOTTOM} />)}
            {display === "candles" ? visible.map((point, index) => {
              const up = point.close >= point.open;
              const center = x(index);
              const bodyTop = Math.min(y(point.open), y(point.close));
              const bodyHeight = Math.max(1, Math.abs(y(point.open) - y(point.close)));
              return <g className={up ? "candle-up" : "candle-down"} key={point.timestamp}><line x1={center} y1={y(point.high)} x2={center} y2={y(point.low)} /><rect x={center - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} /><rect className="volume-bar" x={center - candleWidth / 2} y={VOLUME_BOTTOM - (point.volume / volumeMax) * (VOLUME_BOTTOM - VOLUME_TOP)} width={candleWidth} height={(point.volume / volumeMax) * (VOLUME_BOTTOM - VOLUME_TOP)} /></g>;
            }) : <polyline className="token-line" points={polyline(lineCoordinates(visible.map((point) => point.close)))} />}
            {[0, 1, 2, 3].map((tick) => {
              const price = max - (tick / 3) * span;
              return <text className="axis-label" key={tick} x={WIDTH - RIGHT + 6} y={PRICE_TOP + (tick / 3) * (PRICE_BOTTOM - PRICE_TOP) + 3}>{formatUsd(price)}</text>;
            })}
            {current !== null ? <g className="price-tag"><line x1={LEFT} y1={y(current)} x2={WIDTH - RIGHT} y2={y(current)} /><rect x={WIDTH - RIGHT} y={y(current) - 8} width={RIGHT - 2} height="16" /><text x={WIDTH - RIGHT + 4} y={y(current) + 3}>{formatUsd(current)}</text></g> : null}
            {active !== null ? <line className="crosshair" x1={x(active)} y1={PRICE_TOP} x2={x(active)} y2={VOLUME_BOTTOM} /> : null}
            {[0, Math.max(0, visible.length - 1)].map((index) => <text className="time-label" key={index} x={index ? WIDTH - RIGHT - 70 : LEFT} y={HEIGHT - 8}>{new Date(visible[index]!.timestamp * 1000).toLocaleDateString()}</text>)}
          </svg>
          <table className="sr-only"><caption>Visible OHLCV data</caption><thead><tr><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></tr></thead><tbody>{visible.map((point) => <tr key={point.timestamp}><td>{new Date(point.timestamp * 1000).toISOString()}</td><td>{point.open}</td><td>{point.high}</td><td>{point.low}</td><td>{point.close}</td><td>{point.volume}</td></tr>)}</tbody></table>
        </>
      ) : <EmptyTradingFrame configured={market.configured} error={market.error} />}
      <footer><span>{market.source ? `Data: ${market.source}` : "Market data inactive"}</span><span>{loading ? "Loading…" : "Wheel to zoom · drag to pan · arrows inspect"}</span></footer>
    </article>
  );
}

function LatticeLedgerChart({ samples, market }: { samples: BridgeSample[]; market: MarketData }) {
  const [active, setActive] = useState<number | null>(null);
  const reserves = samples.map((sample) => Number(BigInt(sample.reservesAtomic)) / 1e9);
  const liabilities = samples.map((sample) => Number(BigInt(sample.liabilitiesAtomic)) / 1e9);
  const all = reserves.flatMap((value, index) => [value, liabilities[index]!]);
  const max = Math.max(...all, 1);
  const reservePoints = reserves.map((value, index) => ({ x: LEFT + ((index + .5) / reserves.length) * PLOT_WIDTH, y: PRICE_BOTTOM - (value / max) * (PRICE_BOTTOM - PRICE_TOP) }));
  const liabilityPoints = liabilities.map((value, index) => ({ x: LEFT + ((index + .5) / liabilities.length) * PLOT_WIDTH, y: PRICE_BOTTOM - (value / max) * (PRICE_BOTTOM - PRICE_TOP) }));
  const selected = active === null ? samples.at(-1) : samples[active];
  const latest = samples.at(-1);

  function select(event: React.PointerEvent<SVGSVGElement>) {
    if (!samples.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    setActive(Math.max(0, Math.min(samples.length - 1, Math.floor(((chartX - LEFT) / PLOT_WIDTH) * samples.length))));
  }

  return (
    <article className="terminal-card lattice-terminal">
      <header className="terminal-header"><div className="asset-heading"><span className="asset-mark lattice">LAT</span><div><small>Lattice chain · native coin</small><h3>{`LAT / ${market.configured ? market.symbol ?? "TOKEN" : "TOKEN"}`}</h3><p>{market.configured ? `Redeemable 1:1 for ${market.symbol ?? "TOKEN"} · not a market price` : "Redeemable 1:1 · awaiting token CA"}</p></div></div><div className="terminal-price"><strong>{liabilities.at(-1)?.toLocaleString() ?? "—"} LAT</strong><span>{latest?.label ?? "Collecting"}</span></div></header>
      <div className="terminal-stats"><div><span>Locked reserves</span><strong>{reserves.at(-1)?.toLocaleString() ?? "—"}</strong></div><div><span>Issued + pending</span><strong>{liabilities.at(-1)?.toLocaleString() ?? "—"}</strong></div><div><span>Coverage</span><strong>{latest?.label ?? "—"}</strong></div><div><span>Latest slot</span><strong>{latest?.slot.toLocaleString() ?? "—"}</strong></div><div><span>Mode</span><strong>Test assets</strong></div></div>
      <div className="terminal-tools ledger-tools"><div className="interval-tabs"><button className="active">Finalized observations</button></div><div className="range-tabs"><button className="active">All</button></div></div>
      <div className="ohlcv-readout"><span>R <b>{selected ? Number(BigInt(selected.reservesAtomic)) / 1e9 : "—"}</b></span><span>L <b>{selected ? Number(BigInt(selected.liabilitiesAtomic)) / 1e9 : "—"}</b></span><span>Coverage <b>{selected?.label ?? "—"}</b></span><span>Slot <b>{selected?.slot ?? "—"}</b></span></div>
      {samples.length ? (
        <svg className="trading-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0} aria-label="Locked reserves and issued liabilities. Arrow keys inspect observations." onPointerMove={select} onPointerLeave={() => setActive(null)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault(); setActive((index) => Math.max(0, Math.min(samples.length - 1, (index ?? samples.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
        }}>
          <title>Lattice reserves and liabilities</title>
          {[PRICE_TOP, 72, 126, PRICE_BOTTOM, VOLUME_BOTTOM].map((gridY) => <line className="grid" key={gridY} x1={LEFT} y1={gridY} x2={WIDTH - RIGHT} y2={gridY} />)}
          {[LEFT, 130, 248, 366, WIDTH - RIGHT].map((gridX) => <line className="grid" key={gridX} x1={gridX} y1={PRICE_TOP} x2={gridX} y2={VOLUME_BOTTOM} />)}
          {market.currentPriceUsd !== null ? <g className="target-band"><line x1={LEFT} y1={35} x2={WIDTH - RIGHT} y2={35} /><text x={LEFT + 4} y={29}>target 1:1 redemption value {formatUsd(market.currentPriceUsd)} — bridge not active</text></g> : null}
          <polyline className="reserve-line" points={polyline(reservePoints)} /><polyline className="liability-line" points={polyline(liabilityPoints)} />
          {active !== null ? <line className="crosshair" x1={reservePoints[active]!.x} y1={PRICE_TOP} x2={reservePoints[active]!.x} y2={VOLUME_BOTTOM} /> : null}
          <text className="axis-label" x={WIDTH - RIGHT + 6} y={PRICE_TOP + 3}>{max.toFixed(0)}</text><text className="axis-label" x={WIDTH - RIGHT + 6} y={PRICE_BOTTOM + 3}>0</text>
          <text className="time-label" x={LEFT} y={HEIGHT - 8}>first sample</text><text className="time-label" x={WIDTH - RIGHT - 72} y={HEIGHT - 8}>latest finalized</text>
        </svg>
      ) : <EmptyTradingFrame configured error="Collecting finalized ledger observations" />}
      <div className="chart-legend"><span><i className="reserve" />Locked reserves</span><span><i className="liability" />Issued + pending</span></div>
      <table className="sr-only"><caption>Ledger backing observations</caption><thead><tr><th>Slot</th><th>Reserves</th><th>Liabilities</th><th>Coverage</th></tr></thead><tbody>{samples.map((sample) => <tr key={sample.sequence}><td>{sample.slot}</td><td>{sample.reservesAtomic}</td><td>{sample.liabilitiesAtomic}</td><td>{sample.label}</td></tr>)}</tbody></table>
      <footer><span>{NATIVE_ENVIRONMENT_LABEL} · test assets · not real backing</span><span>Target redemption ratio 1:1 · production bridge inactive</span></footer>
    </article>
  );
}

export function MarketPair({ initialMarket, samples }: { initialMarket: MarketData; samples: BridgeSample[] }) {
  const [market, setMarket] = useState(initialMarket);
  const [loading, setLoading] = useState(false);
  const [display, setDisplay] = useState<"candles" | "line">("candles");

  async function reload(range: MarketRange, interval: MarketInterval) {
    setLoading(true);
    try {
      const response = await fetch(`/api/market?range=${range}&interval=${interval}`);
      setMarket(await response.json() as MarketData);
    } finally { setLoading(false); }
  }

  return <div className="terminal-pair"><TokenTradingChart market={market} loading={loading} display={display} onDisplay={setDisplay} onRange={(range) => void reload(range, market.interval)} onInterval={(interval) => void reload(market.range, interval)} /><div className="pair-link" aria-hidden="true">↔</div><LatticeLedgerChart samples={samples} market={market} /></div>;
}
