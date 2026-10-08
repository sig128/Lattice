const GECKO_ORIGIN = "https://api.geckoterminal.com";
const DEX_ORIGIN = "https://api.dexscreener.com";
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type MarketRange = "24H" | "7D" | "30D";
export type MarketInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1D";
export interface MarketPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  priceUsd: number;
}
export interface MarketData {
  configured: boolean;
  mint: string | null;
  name: string | null;
  symbol: string | null;
  quoteSymbol: string | null;
  imageUrl: string | null;
  source: "GeckoTerminal" | "DexScreener" | null;
  range: MarketRange;
  interval: MarketInterval;
  currentPriceUsd: number | null;
  changePercent: number | null;
  points: MarketPoint[];
  poolAddress: string | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  error: string | null;
}

function safeText(value: unknown, max = 80) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) || null : null;
}

function safeNumber(value: unknown) {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
}

export function isAllowedMarketUrl(url: URL) {
  return (url.origin === GECKO_ORIGIN && url.pathname.startsWith("/api/v2/networks/solana/"))
    || (url.origin === DEX_ORIGIN && url.pathname.startsWith("/token-pairs/v1/solana/"));
}

async function safeFetch(url: URL, fetcher: typeof fetch, timeoutMs: number) {
  if (!isAllowedMarketUrl(url)) throw new Error("Market provider URL is not allowlisted");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "Lattice-local-development/0.1" },
    });
    if (!response.ok) throw new Error(`Market provider HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function rangeConfig(range: MarketRange, interval: MarketInterval) {
  const intervalConfig: Record<MarketInterval, { timeframe: string; aggregate: string; seconds: number }> = {
    "1m": { timeframe: "minute", aggregate: "1", seconds: 60 },
    "5m": { timeframe: "minute", aggregate: "5", seconds: 300 },
    "15m": { timeframe: "minute", aggregate: "15", seconds: 900 },
    "1h": { timeframe: "hour", aggregate: "1", seconds: 3_600 },
    "4h": { timeframe: "hour", aggregate: "4", seconds: 14_400 },
    "1D": { timeframe: "day", aggregate: "1", seconds: 86_400 },
  };
  const rangeSeconds = range === "24H" ? 86_400 : range === "7D" ? 604_800 : 2_592_000;
  const selected = intervalConfig[interval];
  return { ...selected, limit: String(Math.max(2, Math.min(240, Math.ceil(rangeSeconds / selected.seconds)))) };
}

export async function fetchMarketData(
  mint: string | null,
  range: MarketRange,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5_000,
  interval: MarketInterval = range === "24H" ? "1h" : range === "7D" ? "4h" : "1D",
): Promise<MarketData> {
  const empty: MarketData = {
    configured: Boolean(mint), mint, name: null, symbol: null, quoteSymbol: null, imageUrl: null,
    source: null, range, interval, currentPriceUsd: null, changePercent: null, points: [],
    poolAddress: null, volume24hUsd: null, liquidityUsd: null, marketCapUsd: null, fdvUsd: null, error: null,
  };
  if (!mint) return empty;
  if (!MINT_PATTERN.test(mint)) return { ...empty, error: "Configured mint is not a valid Solana public key" };

  try {
    const poolsUrl = new URL(`/api/v2/networks/solana/tokens/${mint}/pools`, GECKO_ORIGIN);
    poolsUrl.searchParams.set("page", "1");
    poolsUrl.searchParams.set("include", "base_token,quote_token");
    const pools = await safeFetch(poolsUrl, fetcher, timeoutMs) as {
      data?: Array<{ id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: unknown } }> }>;
      included?: Array<{ id?: unknown; attributes?: Record<string, unknown> }>;
    };
    const pool = pools.data?.[0];
    const poolId = safeText(pool?.id, 128)?.replace(/^solana_/, "");
    if (!poolId) throw new Error("No GeckoTerminal pool found for configured mint");
    const baseId = safeText(pool?.relationships?.base_token?.data?.id, 128)?.replace(/^solana_/, "");
    const quoteId = safeText(pool?.relationships?.quote_token?.data?.id, 128)?.replace(/^solana_/, "");
    const tokenSide = baseId === mint ? "base" : "quote";
    const metadata = pools.included?.find((item) => safeText(item.id, 128) === `solana_${mint}`)?.attributes ?? {};
    const pairedId = tokenSide === "base" ? quoteId : baseId;
    const pairMetadata = pools.included?.find((item) => safeText(item.id, 128) === `solana_${pairedId}`)?.attributes ?? {};
    const attributes = pool?.attributes ?? {};
    const config = rangeConfig(range, interval);
    const ohlcvUrl = new URL(`/api/v2/networks/solana/pools/${poolId}/ohlcv/${config.timeframe}`, GECKO_ORIGIN);
    ohlcvUrl.searchParams.set("aggregate", config.aggregate);
    ohlcvUrl.searchParams.set("limit", config.limit);
    ohlcvUrl.searchParams.set("currency", "usd");
    ohlcvUrl.searchParams.set("token", tokenSide);
    const ohlcv = await safeFetch(ohlcvUrl, fetcher, timeoutMs) as {
      data?: { attributes?: { ohlcv_list?: unknown } };
    };
    const rows = ohlcv.data?.attributes?.ohlcv_list;
    if (!Array.isArray(rows)) throw new Error("Malformed GeckoTerminal OHLCV response");
    const points = rows.flatMap((row): MarketPoint[] => {
      if (!Array.isArray(row)) return [];
      const timestamp = safeNumber(row[0]);
      const open = safeNumber(row[1]);
      const high = safeNumber(row[2]);
      const low = safeNumber(row[3]);
      const close = safeNumber(row[4]);
      const volume = safeNumber(row[5]);
      return timestamp !== null && open !== null && high !== null && low !== null && close !== null && volume !== null
        ? [{ timestamp, open, high, low, close, volume, priceUsd: close }]
        : [];
    }).sort((a, b) => a.timestamp - b.timestamp);
    if (!points.length) throw new Error("No valid GeckoTerminal OHLCV points");
    const first = points[0]!.priceUsd;
    const current = points.at(-1)!.priceUsd;
    return {
      configured: true, mint,
      name: safeText(metadata.name) ?? "Configured token",
      symbol: safeText(metadata.symbol, 16),
      quoteSymbol: safeText(pairMetadata.symbol, 16),
      imageUrl: safeText(metadata.image_url, 300),
      source: "GeckoTerminal", range, interval, currentPriceUsd: current,
      changePercent: first === 0 ? null : ((current - first) / first) * 100,
      points, poolAddress: poolId,
      volume24hUsd: safeNumber((attributes.volume_usd as Record<string, unknown> | undefined)?.h24),
      liquidityUsd: safeNumber(attributes.reserve_in_usd),
      marketCapUsd: safeNumber(attributes.market_cap_usd),
      fdvUsd: safeNumber(attributes.fdv_usd),
      error: null,
    };
  } catch (geckoError) {
    try {
      const dexUrl = new URL(`/token-pairs/v1/solana/${mint}`, DEX_ORIGIN);
      const pairs = await safeFetch(dexUrl, fetcher, timeoutMs) as Array<Record<string, unknown>>;
      const pair = Array.isArray(pairs) ? pairs[0] : null;
      const price = safeNumber(pair?.priceUsd);
      if (price === null) throw new Error("No DexScreener price");
      const base = pair?.baseToken && typeof pair.baseToken === "object" ? pair.baseToken as Record<string, unknown> : {};
      return {
        ...empty, configured: true, source: "DexScreener", currentPriceUsd: price,
        points: [{ timestamp: Math.floor(Date.now() / 1000), open: price, high: price, low: price, close: price, volume: 0, priceUsd: price }],
        name: safeText(base.name) ?? "Configured token", symbol: safeText(base.symbol, 16),
        quoteSymbol: safeText((pair?.quoteToken as Record<string, unknown> | undefined)?.symbol, 16),
        poolAddress: safeText(pair?.pairAddress, 96),
        volume24hUsd: safeNumber((pair?.volume as Record<string, unknown> | undefined)?.h24),
        liquidityUsd: safeNumber((pair?.liquidity as Record<string, unknown> | undefined)?.usd),
        marketCapUsd: safeNumber(pair?.marketCap),
        fdvUsd: safeNumber(pair?.fdv),
        error: `Historical series unavailable; GeckoTerminal: ${geckoError instanceof Error ? geckoError.message : "failed"}`,
      };
    } catch {
      return { ...empty, configured: true, error: geckoError instanceof Error ? geckoError.message : "Market data unavailable" };
    }
  }
}
