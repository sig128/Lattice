import { fetchMarketData } from "../app/lib/market-data.js";

// Well-known USDC mint is used only to verify the provider integration.
// It is never substituted for the project's configured source token.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
async function main() {
  const result = await fetchMarketData(USDC_MINT, "24H");
  if (result.source !== "GeckoTerminal" || result.points.length < 2) {
    throw new Error(`Market smoke test failed: ${result.error ?? "insufficient points"}`);
  }
  console.log(JSON.stringify({
    testMint: USDC_MINT,
    displayOnly: false,
    source: result.source,
    points: result.points.length,
    currentPriceUsd: result.currentPriceUsd,
  }, null, 2));
}

void main();
