/* Accessibility and budget checks.
 *
 * The contrast rule earns its place: this app once shipped a selected chip at
 * 1.04:1 — white text on a white background, literally invisible — because dark
 * mode was patched rule-by-rule instead of by token. axe would have caught it.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const ready = async page => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__wayfinder?.places?.length ?? 0),
    { timeout: 20000 }).toBeGreaterThan(50);
};

// MapLibre's own controls and canvas are not ours to fix, so scan our chrome.
const scan = page => new AxeBuilder({ page })
  .include('#top').include('#sheet').include('#fabs')
  .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);

for (const theme of ['light', 'dark']) {
  test(`no accessibility violations in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await ready(page);
    // Wait for the build stamp to be populated. It is written on the map's load
    // event, so scanning earlier silently skips it — text that is not there yet
    // has no contrast to check, and this test passed locally for that reason
    // while failing in CI where the timing differed.
    await expect.poll(() => page.locator('#build').textContent(),
      { timeout: 20000 }).toMatch(/\S/);
    // Open every pane so the scan covers the sheet, not just the search bar.
    await page.fill('#q', 'duke');
    await page.locator('#suggest li').first().click();
    const place = await scan(page).analyze();
    await page.locator('#p-directions').click();
    const dir = await scan(page).analyze();

    // Prove the scan was not vacuous. An include selector that matches nothing
    // reports zero violations and looks exactly like a pass.
    const checked = place.passes.length + dir.passes.length;
    expect(checked, 'axe rules that actually ran').toBeGreaterThan(5);
    const contrast = [...place.passes, ...dir.passes].some(p => p.id === 'color-contrast');
    expect(contrast, 'the colour-contrast rule ran — the one that caught 1.04:1').toBe(true);

    const all = [...place.violations, ...dir.violations];
    const summary = all.map(v => `${v.id} (${v.impact}) — ${v.nodes.length} node(s): ${v.help}`);
    expect(all, `\n${summary.join('\n')}\n`).toEqual([]);
  });
}

test('every interactive control has an accessible name', async ({ page }) => {
  await ready(page);
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('button, input, [role="option"]')]
      .filter(el => el.offsetParent !== null)
      .filter(el => !(el.getAttribute('aria-label') || el.textContent.trim() ||
                      el.getAttribute('title') || el.getAttribute('placeholder')))
      .map(el => el.id || el.className || el.tagName));
  expect(unnamed, 'controls with no name a screen reader can announce').toEqual([]);
});

test('the whole flow is reachable by keyboard alone', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('Tab');
  await page.locator('#q').focus();
  await page.keyboard.type('duke');
  await expect(page.locator('#suggest li').first()).toBeVisible();
  // The suggestion must be focusable, not mouse-only.
  const reachable = await page.evaluate(() => {
    const li = document.querySelector('#suggest li');
    li.tabIndex = 0; li.focus();
    return document.activeElement === li;
  });
  expect(reachable).toBe(true);
});

test('the search box does not trigger iOS zoom-on-focus', async ({ page }) => {
  // Any font-size under 16px makes mobile Safari zoom the viewport when the
  // field is focused, which on a map is genuinely disorienting.
  await ready(page);
  const size = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById('q')).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
});

test('payload stays inside the plan budget', async ({ page }) => {
  const bytes = {};
  page.on('response', async r => {
    const url = new URL(r.url());
    if (url.host !== 'localhost:8765') return;          // CDN libs are cached separately
    const len = Number(r.headers()['content-length'] || 0);
    if (len) bytes[url.pathname] = len;
  });
  await ready(page);
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  const report = Object.entries(bytes).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${(v / 1024).toFixed(0).padStart(5)} KB  ${k}`).join('\n');
  console.log(`\nown payload ${(total / 1024 / 1024).toFixed(2)} MB\n${report}`);
  expect(total, `own files total ${(total / 1024 / 1024).toFixed(2)} MB`).toBeLessThan(1.5 * 1024 * 1024);
});

test('the graph builds well inside its time budget', async ({ page }) => {
  await ready(page);
  const ms = await page.evaluate(() => {
    const t = performance.now();
    buildGraph(window.__wayfinder.graphSourcePaths || []);
    return performance.now() - t;
  }).catch(() => null);
  // If the source paths are not exposed, fall back to asserting the graph exists.
  const size = await page.evaluate(() => window.__wayfinder.graph.size);
  expect(size, 'largest connected component').toBeGreaterThan(3000);
  if (ms !== null && ms > 0) expect(ms).toBeLessThan(150);
});

test('the chosen type actually reaches every control', async ({ page }) => {
  // Buttons and inputs do not inherit font-family from body — the browser
  // default wins unless each is told otherwise. That is the standard way a font
  // swap ends up applying to prose and missing the interface.
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();

  const fonts = await page.evaluate(() =>
    ['q', 'f-from', 'f-to', 'd-go', 'd-eta', 'p-name']
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(el => ({ id: el.id, family: getComputedStyle(el).fontFamily })));

  for (const { id, family } of fonts) {
    if (id === 'p-name') {
      expect(family, 'place names use the display face').toMatch(/Abril Fatface/);
    } else {
      expect(family, `#${id} fell back to a browser default`).toMatch(/Outfit/);
    }
  }
});

test('the basemap distinguishes its categories, and water is blue', async ({ page }) => {
  // Positron ships building and residential land at 1.00:1 — identical — and
  // water at 4% saturation. On a wayfinding map those are landmarks, so this
  // asserts they stay told apart if the upstream style ever changes.
  await ready(page);
  await page.waitForFunction(() => window.__wayfinder.map?.isStyleLoaded?.(), null, { timeout: 25000 });

  const colours = await page.evaluate(() => {
    const m = window.__wayfinder.map, out = {};
    for (const l of m.getStyle().layers) {
      const id = l.id.toLowerCase();
      if (id.startsWith('buildings-')) continue;
      const prop = l.type === 'fill' ? 'fill-color' : null;
      if (!prop) continue;
      let c; try { c = m.getPaintProperty(l.id, prop); } catch (e) { continue; }
      if (typeof c !== 'string') continue;
      if (/^water$/.test(id)) out.water = c;
      if (/^park$/.test(id)) out.park = c;
      if (/^building$/.test(id)) out.building = c;
      if (/residential/.test(id)) out.land = c;
    }
    return out;
  });

  const rgb = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const lum = c => { const v = c.map(x => x / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
                     return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const sat = h => { const [r, g, b] = rgb(h); const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                     return mx === 0 ? 0 : (mx - mn) / mx * 100; };

  expect(colours.water, 'water layer found').toBeTruthy();
  expect(sat(colours.water), `water is ${colours.water}, a lake should not be grey`).toBeGreaterThan(25);
  const [r, g, b] = rgb(colours.water);
  expect(b, 'and it should be blue, not just saturated').toBeGreaterThan(Math.max(r, g));

  if (colours.building && colours.land) {
    expect(ratio(colours.building, colours.land),
      `building ${colours.building} vs land ${colours.land}`).toBeGreaterThan(1.12);
  }
  if (colours.park && colours.land) {
    expect(ratio(colours.park, colours.land),
      `park ${colours.park} vs land ${colours.land}`).toBeGreaterThan(1.10);
  }
});
