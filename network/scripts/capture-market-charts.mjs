import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

const empty = await context.newPage();
await empty.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
await empty.locator(".terminal-pair").screenshot({ path: "docs/screenshots/chart-pair-awaiting-mint.png" });

const dev = await context.newPage();
await dev.goto("http://127.0.0.1:3001", { waitUntil: "networkidle", timeout: 30_000 });
await dev.getByText("Data: GeckoTerminal").waitFor({ timeout: 20_000 });
await dev.locator(".terminal-pair").screenshot({ path: "docs/screenshots/chart-pair-dev-usdc.png" });

console.log(JSON.stringify({
  empty: "docs/screenshots/chart-pair-awaiting-mint.png",
  developmentOnly: "docs/screenshots/chart-pair-dev-usdc.png",
  testMint: "USDC · never substituted for the project token",
}, null, 2));
await browser.close();
