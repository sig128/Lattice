import { publicConfig } from "@lattice/config";
import { fetchMarketData, type MarketData, type MarketInterval, type MarketRange } from "../../lib/market-data";

export const dynamic = "force-dynamic";

const cache = new Map<string, { expiresAt: number; value: MarketData }>();
const ranges = new Set<MarketRange>(["24H", "7D", "30D"]);
const intervals = new Set<MarketInterval>(["1m", "5m", "15m", "1h", "4h", "1D"]);

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("range")?.toUpperCase() as MarketRange | undefined;
  const range = requested && ranges.has(requested) ? requested : "24H";
  const requestedInterval = new URL(request.url).searchParams.get("interval") as MarketInterval | null;
  const interval = requestedInterval && intervals.has(requestedInterval) ? requestedInterval : range === "24H" ? "1h" : range === "7D" ? "4h" : "1D";
  const mint = publicConfig.source.mint;
  if (!mint) {
    return Response.json(await fetchMarketData(null, range, fetch, 5_000, interval), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }
  const key = `${mint}:${range}:${interval}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Response.json(cached.value, { headers: { "Cache-Control": "public, max-age=30" } });
  }
  const value = await fetchMarketData(mint, range, fetch, 5_000, interval);
  cache.set(key, { expiresAt: Date.now() + 60_000, value });
  return Response.json(value, { headers: { "Cache-Control": "public, max-age=30" } });
}
