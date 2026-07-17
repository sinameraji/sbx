// Records the preview URL in headless Chromium for the demo's browser beat.
// Usage: node demo/browser.js <previewUrl> <outDir>   → outDir/browser.webm
const { chromium } = require(process.env.PLAYWRIGHT_DIR
  ? `${process.env.PLAYWRIGHT_DIR}/node_modules/playwright`
  : "playwright");

(async () => {
  const [url, outDir] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, 250);
  await page.waitForTimeout(2500);
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(2000);
  const video = page.video();
  await ctx.close();
  const path = await video.path();
  await browser.close();
  console.log(path);
})();
