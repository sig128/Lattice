import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const output = "docs/screenshots";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto("http://127.0.0.1:3000/bridge", { waitUntil: "networkidle" });
await page.getByText("Local development wallet").waitFor();
await page.screenshot({ path: `${output}/bridge-idle.png`, fullPage: true });

await page.getByRole("button", { name: "Get local SOL" }).click();
await page.getByText(/Local SOL confirmed/).waitFor({ timeout: 20_000 });
await page.getByRole("button", { name: "Get 100 source test units" }).click();
await page.getByText(/100 source test units minted/).waitFor({ timeout: 25_000 });
await page.getByLabel("Amount").fill("10");
await page.getByText("10", { exact: true }).last().waitFor();
await page.screenshot({ path: `${output}/bridge-preview.png`, fullPage: true });

await page.getByRole("button", { name: "Deposit and issue" }).click();
await page.getByText("Completed with separate source and destination signatures.").waitFor({ timeout: 60_000 });
await page.screenshot({ path: `${output}/bridge-completed.png`, fullPage: true });
const sourceHref = await page.getByRole("link", { name: /Source evidence/ }).getAttribute("href");
const destinationHref = await page.getByRole("link", { name: /Destination evidence/ }).getAttribute("href");
const receipt = await page.locator(".receipt-evidence strong").textContent();

await page.getByRole("button", { name: "Swap bridge direction" }).click();
await page.getByLabel("Amount").fill("3");
await page.getByRole("button", { name: "Burn and redeem" }).click();
await page.getByText(/Submitted /).waitFor({ timeout: 20_000 });
await page.getByText("Completed with separate source and destination signatures.").waitFor({ timeout: 60_000 });
const redemptionReceipt = await page.locator(".receipt-evidence strong").textContent();
const redemptionSourceHref = await page.getByRole("link", { name: /Source evidence/ }).getAttribute("href");
const redemptionDestinationHref = await page.getByRole("link", { name: /Destination evidence/ }).getAttribute("href");

console.log(JSON.stringify({
  deposit: { receipt, sourceHref, destinationHref },
  redemption: { receipt: redemptionReceipt, sourceHref: redemptionSourceHref, destinationHref: redemptionDestinationHref },
}, null, 2));
await browser.close();
