#!/usr/bin/env node
// Helper script to explore Rivestream's API structure before implementing auto-detection.
// Run with: node explore-rivestream.js "https://rivestream.org/watch?type=tv&id=79744"

const { chromium } = require('playwright');

const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('Usage: node explore-rivestream.js <rivestream-show-url>');
  process.exit(1);
}

(async () => {
  console.log('🔍 Exploring:', pageUrl, '\n');

  const browser = await chromium.launch({
    headless: false, // visible so you can inspect the page
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
  });

  // Capture all JSON API responses, log those containing season/episode info
  context.on('response', async response => {
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const text = await response.text().catch(() => '');
      if (!text || text.length > 500_000) return;
      const data = JSON.parse(text);
      const str = JSON.stringify(data).toLowerCase();
      const interesting = str.includes('season') || str.includes('episode_count') || str.includes('number_of_seasons');
      const label = interesting ? '✅ [SEASON DATA]' : '📦 [json]      ';
      console.log(`${label} ${response.url()}`);
      if (interesting) {
        console.log(JSON.stringify(data, null, 2).slice(0, 2000));
        console.log('---');
      }
    } catch {}
  });

  const page = await context.newPage();
  console.log('Loading page...\n');
  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (e) {
    console.log('⚠️  Load warning (ok):', e.message.slice(0, 80));
  }

  await page.waitForTimeout(3000);

  // Check Next.js __NEXT_DATA__ script tag (common in React/Next sites)
  const nextData = await page.evaluate(() => {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }).catch(() => null);

  if (nextData) {
    console.log('\n📄 Found __NEXT_DATA__ (Next.js page props):');
    const str = JSON.stringify(nextData, null, 2);
    console.log(str.slice(0, 3000), str.length > 3000 ? '\n...(truncated)' : '');
  } else {
    console.log('\n(no __NEXT_DATA__ found)');
  }

  // Check DOM for season selectors and related elements
  const domInfo = await page.evaluate(() => {
    const result = {};
    const selects = [...document.querySelectorAll('select')].map(s => ({
      id: s.id, class: s.className.slice(0, 80),
      options: [...s.options].slice(0, 30).map(o => ({ text: o.text, value: o.value })),
    })).filter(s => s.options.length > 0);
    if (selects.length) result.selects = selects;

    const seasonEls = [...document.querySelectorAll('[class*="season" i], [data-season], [id*="season" i]')]
      .slice(0, 15)
      .map(e => ({
        tag: e.tagName,
        class: e.className.slice(0, 60),
        text: e.textContent.trim().slice(0, 80),
        dataset: Object.fromEntries(Object.entries(e.dataset).slice(0, 5)),
      }));
    if (seasonEls.length) result.seasonElements = seasonEls;

    return result;
  }).catch(() => null);

  if (domInfo && Object.keys(domInfo).length > 0) {
    console.log('\n🖥️  DOM season-related elements:');
    console.log(JSON.stringify(domInfo, null, 2));
  } else {
    console.log('\n(no DOM season elements found)');
  }

  await page.screenshot({ path: 'rivestream-explore.png' });
  console.log('\n📸 Screenshot saved: rivestream-explore.png');
  console.log('\n✅ Done. Keep the browser open to inspect manually. Ctrl+C to exit.\n');

  await page.waitForTimeout(60_000).catch(() => {});
  await browser.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
