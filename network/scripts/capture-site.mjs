import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const output = "docs/screenshots";
await mkdir(output, { recursive: true });

const desktop = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await desktop.newPage();
await page.goto("http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(850);
await page.locator(".topbar").screenshot({ path: `${output}/navbar-mid-walk.png` });
await page.locator('[data-phase="waving"]').waitFor({ timeout: 4_000 });
await page.locator(".topbar").screenshot({ path: `${output}/navbar-wave.png` });
await page.locator('[data-phase="idle"]').waitFor({ timeout: 6_000 });
await page.getByText("Finalized slot").waitFor();
await page.screenshot({ path: `${output}/homepage-desktop.png`, fullPage: true });
await page.keyboard.press("Meta+K");
await page.getByRole("dialog", { name: "Command palette" }).waitFor();
await page.keyboard.press("Escape");
await page.getByRole("button", { name: /Copy http:\/\/127\.0\.0\.1:8899/ }).click();
await page.getByRole("button", { name: /Copy http:\/\/127\.0\.0\.1:8899/ }).getByText("Copied").waitFor();

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const mobilePage = await mobile.newPage();
await mobilePage.goto("http://127.0.0.1:3000", { waitUntil: "networkidle" });
await mobilePage.screenshot({ path: `${output}/homepage-mobile.png`, fullPage: true });
await mobilePage.getByRole("button", { name: "Menu" }).click();
await mobilePage.getByRole("dialog", { name: "Navigation menu" }).waitFor();
await mobilePage.screenshot({ path: `${output}/mobile-index.png`, fullPage: false });
await mobilePage.keyboard.press("Escape");

await browser.close();
console.log(JSON.stringify({
  desktop: `${output}/homepage-desktop.png`,
  mobile: `${output}/homepage-mobile.png`,
  mobileIndex: `${output}/mobile-index.png`,
  navbarMidWalk: `${output}/navbar-mid-walk.png`,
  navbarWave: `${output}/navbar-wave.png`,
  interactions: ["command palette open/escape", "RPC copy copied state", "mobile index open/escape"],
}, null, 2));
