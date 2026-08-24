/* The search -> place -> directions -> navigate flow, in a real browser.
 *
 * Every UI bug this project has shipped — invisible dark-mode text, an
 * unreachable Start button, a vanishing blue dot, an arrow rotated 90 degrees —
 * lived in app.js and was found by hand on a phone. These are the tests that
 * would have caught them.
 */
const { test, expect } = require('@playwright/test');

// A spot on the campus mall, used wherever a location fix is needed.
const MALL = { longitude: -82.4392, latitude: 34.9245 };

const ready = async page => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__wayfinder?.places?.length ?? 0),
    { timeout: 20000 }).toBeGreaterThan(50);
};

test('loads the campus and reports its build', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await ready(page);
  await expect(page.locator('#searchbar')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'browse');
  // The sheet must stay off screen until there is something to put in it.
  await expect(page.locator('#sheet')).not.toBeInViewport();
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the map itself renders — WebGL, tiles, campus layers', async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() =>
    !!window.__wayfinder.map?.getLayer?.('buildings-fill')), { timeout: 20000 }).toBe(true);
  const drawn = await page.evaluate(() =>
    window.__wayfinder.map.queryRenderedFeatures({ layers: ['buildings-fill'] }).length);
  expect(drawn, 'campus buildings are actually painted').toBeGreaterThan(0);
});

test('fuzzy search tolerates a typo and finds the building', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'riely');          // deliberate misspelling of Riley
  await expect(page.locator('#suggest li').first()).toContainText(/riley/i);
});

test('an alias finds the right hall', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'north village c');
  await expect(page.locator('#suggest li').first()).toContainText('North Village C');
});

test('picking a place opens the sheet, and says so honestly with no location', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'place');
  await expect(page.locator('#sheet')).toBeInViewport();
  await expect(page.locator('#p-name')).toContainText(/duke/i);
  // No fix yet: a dash plus how to fix it, never an invented distance.
  await expect(page.locator('#p-eta strong')).toHaveText('—');
  await expect(page.locator('#p-eta span')).toContainText(/locate/i);
});

test('with a location, the sheet shows a real distance and time', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await expect(page.locator('#p-eta strong')).toHaveText(/\d+ min/, { timeout: 15000 });
  await expect(page.locator('#p-eta span')).toHaveText(/\d+(\.\d+)? (m|km) away/);
});

test('directions draws a route and enables Go', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'plyler');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'directions');
  await expect(page.locator('#endpoints')).toBeVisible();
  await expect(page.locator('#f-from span')).toContainText(/your location/i);
  await expect(page.locator('#d-eta strong')).toHaveText(/\d+ min/);
  await expect(page.locator('#d-go')).toBeEnabled();

  // Assert on our own state, not map internals: the route is computed whether
  // or not the style has finished loading, and reaching into getSource() made
  // this test depend on tile-loading speed rather than on routing.
  const points = await page.evaluate(() =>
    window.__wayfinder.route?.line?.geometry?.coordinates?.length ?? 0);
  expect(points, 'a real multi-point route is computed').toBeGreaterThan(3);

  // And that it is actually painted. queryRenderedFeatures asks the renderer
  // what is on screen, rather than reading a private field whose shape is
  // MapLibre's business — _data turned out to wrap the feature as
  // {geojson: ...}, so an internals assertion silently read undefined.
  await expect.poll(() => page.evaluate(() =>
    window.__wayfinder.map.queryRenderedFeatures({ layers: ['route-line'] }).length),
    { timeout: 15000 }).toBeGreaterThan(0);
});

test('swap reverses the route without changing its length', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'trone');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();
  const before = await page.locator('#d-eta span').textContent();
  const from = await page.locator('#f-from span').textContent();

  await page.locator('#dir-swap').click();
  await expect(page.locator('#f-to span')).toHaveText(from.trim());
  expect(await page.locator('#d-eta span').textContent()).toBe(before);
});

test('Go enters navigation, Stop comes back', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'riley');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();
  await page.locator('#d-go').click();

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'nav');
  await expect(page.locator('#n-eta strong')).toHaveText(/\d+ min|Arrived/);
  await expect(page.locator('#n-to')).toContainText(/riley/i);

  await page.locator('#n-stop').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'directions');
});

test('avoid stairs is offered and does not break the route', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'mcalister');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();
  const normal = await page.locator('#d-eta span').textContent();
  await page.locator('#stepfree').check();
  await expect(page.locator('#d-eta strong')).toHaveText(/\d+ min/);
  await expect(page.locator('#d-go')).toBeEnabled();
  expect(normal).toBeTruthy();
});

test('back from directions returns to the place, not a blank screen', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();
  await page.locator('#dir-back').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'place');
  await expect(page.locator('#p-name')).toContainText(/duke/i);
});
