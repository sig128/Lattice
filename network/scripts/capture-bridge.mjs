import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const receipts = JSON.parse(await readFile("services/bridge/data/receipts.json", "utf8"));
const latest = receipts.at(-1);
if (!latest) throw new Error("No completed local receipt to capture");

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript((id) => localStorage.setItem("lattice.localBridge.receiptId", id), latest.id);
const page = await context.newPage();
await page.goto("http://127.0.0.1:3000/bridge", { waitUntil: "networkidle" });
await page.getByText("Local development wallet").waitFor();
await page.screenshot({ path: "docs/screenshots/bridge-idle.png", fullPage: true });
await page.getByLabel("Amount").fill("10");
await page.screenshot({ path: "docs/screenshots/bridge-preview.png", fullPage: true });
await page.getByRole("button", { name: "Look up" }).click();
await page.getByText("Receipt restored.").waitFor();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: "docs/screenshots/bridge-completed.png", fullPage: true });
await browser.close();
console.log(JSON.stringify({ receipt: latest.id, screenshots: ["bridge-idle.png", "bridge-preview.png", "bridge-completed.png"] }, null, 2));
