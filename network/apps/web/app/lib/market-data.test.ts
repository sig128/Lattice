import { describe, expect, it } from "vitest";
import { fetchMarketData, isAllowedMarketUrl } from "./market-data";

const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("market data", () => {
  it("returns an honest unconfigured state without fetching", async () => {
    let called = false;
    const result = await fetchMarketData(null, "24H", (async () => {
      called = true;
      return new Response();
    }) as typeof fetch);
    expect(called).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.points).toEqual([]);
  });

  it("allows only fixed provider endpoints", () => {
    expect(isAllowedMarketUrl(new URL("https://api.geckoterminal.com/api/v2/networks/solana/tokens/x/pools"))).toBe(true);
    expect(isAllowedMarketUrl(new URL("https://api.dexscreener.com/token-pairs/v1/solana/x"))).toBe(true);
    expect(isAllowedMarketUrl(new URL("https://api.geckoterminal.com.evil.test/api/v2/networks/solana/x"))).toBe(false);
    expect(isAllowedMarketUrl(new URL("http://127.0.0.1/api/v2/networks/solana/x"))).toBe(false);
  });

  it("sanitizes metadata and parses valid OHLCV", async () => {
    const responses = [
      {
        data: [{
          id: "solana_pool-address",
          relationships: { quote_token: { data: { id: `solana_${mint}` } }, base_token: { data: { id: "solana_other" } } },
        }],
        included: [{ id: `solana_${mint}`, attributes: { name: "<b>USD Coin</b>", symbol: "USDC" } }],
      },
      { data: { attributes: { ohlcv_list: [[2, 1, 1, 1, 1.02, 10], [1, 1, 1, 1, 1, 10]] } } },
    ];
    const fetcher = (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch;
    const result = await fetchMarketData(mint, "24H", fetcher);
    expect(result.source).toBe("GeckoTerminal");
    expect(result.name).toBe("bUSD Coin/b");
    expect(result.points.map((point) => point.timestamp)).toEqual([1, 2]);
    expect(result.changePercent).toBeCloseTo(2);
  });

  it("does not turn malformed provider data into a chart", async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("geckoterminal")) return new Response(JSON.stringify({ data: [{ id: "bad" }] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    const result = await fetchMarketData(mint, "7D", fetcher);
    expect(result.points).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("bounds provider requests with a timeout", async () => {
    const fetcher = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;
    const result = await fetchMarketData(mint, "24H", fetcher, 5);
    expect(result.points).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
