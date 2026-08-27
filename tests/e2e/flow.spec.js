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

test('loads the campus and reports its build @layout', async ({ page }) => {
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
  // Poll, do not sample once. A layer existing and its tiles being painted are
  // different events, and asserting the moment the layer appears is a race that
  // passes or fails on how fast the tiles happen to arrive.
  await expect.poll(() => page.evaluate(() =>
    window.__wayfinder.map.queryRenderedFeatures({ layers: ['buildings-fill'] }).length),
    { timeout: 20000 }).toBeGreaterThan(0);
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

test('picking a place opens the sheet, and says so honestly with no location @layout', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'place');
  await expect(page.locator('#sheet')).toBeInViewport();
  await expect(page.locator('#p-name')).toContainText(/duke/i);
  // No fix yet, so no distance at all — better than a dash captioned with a
  // request for permission nobody has asked to give.
  await expect(page.locator('#p-eta')).toBeHidden();
  await expect(page.locator('#p-directions')).toBeVisible();
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

test('directions draws a route and enables Go @layout', async ({ page, context }) => {
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
  // The heaviest test here: a geolocation fix, a full route, a mode change and
  // a camera animation, all in one. It costs ~6s locally and roughly three
  // times that on a shared runner driving WebGL through SwiftShader, which put
  // it over the 30s cap while every assertion still passed. slow() triples the
  // budget rather than relaxing anything the test actually checks.
  test.slow();
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

test('Go is offered from the place sheet once a route exists', async ({ page, context }) => {
  // A usable route is a state, not the last step of a sequence: if one exists,
  // you can start it without walking through the directions screen first.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();

  await expect(page.locator('#p-go')).toBeVisible();
  await page.locator('#p-go').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'nav');
});

test('with no location there is no Go, because there is no route', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await expect(page.locator('#p-go')).toBeHidden();
  await expect(page.locator('#p-directions')).toBeVisible();
});

test('entering navigation tilts gradually, it does not snap', async ({ page, context }) => {
  // The camera used to pass zoom and pitch to jumpTo as constants, so the whole
  // tilt happened in one frame. Sampling pitch proves it now passes through
  // intermediate values rather than teleporting from flat to 55 degrees.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'plyler');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();
  await expect(page.locator('#d-go')).toBeEnabled();

  // Sample on a timer rather than per animation frame. Several workers each
  // holding a WebGL context starve requestAnimationFrame, so a frame-counting
  // assertion measures machine load as much as it measures the animation.
  const samples = await page.evaluate(async () => {
    const map = window.__wayfinder.map;
    const out = [];
    const id = setInterval(() => out.push(Math.round(map.getPitch() * 10) / 10), 10);
    document.getElementById('d-go').click();
    await new Promise(r => setTimeout(r, 2600));
    clearInterval(id);
    return out;
  });

  // A snap produces two values: flat, then 55. An eased transition passes
  // through many. Distinct values are the property that load cannot fake.
  const distinct = [...new Set(samples.filter(p => p > 2 && p < 50))];
  expect(distinct.length,
    `pitch ${samples[0]} -> ${samples.at(-1)} through ${distinct.length} distinct intermediate values`)
    .toBeGreaterThan(2);
  // The sweep is deliberately gentle (~1.2s), and a starved compositor lands
  // fewer frames, so assert it is clearly tilted rather than exactly arrived.
  expect(samples.at(-1), 'and still arrives tilted').toBeGreaterThan(30);
});

test('Directions opens a route preview even with nothing to route yet', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'directions');
  await expect(page.locator('#endpoints')).toBeVisible();
  await expect(page.locator('#f-to span')).toContainText(/duke/i);
  await expect(page.locator('#f-from span')).toContainText(/choose starting point/i);
  // It must say WHICH end is missing, not just that something is.
  await expect(page.locator('#d-eta span')).toContainText(/starting point/i);
  await expect(page.locator('#d-go')).toBeDisabled();
});

test('"Your location" is offered when choosing a starting point @layout', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();

  await page.locator('#f-from').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'picking');
  // The endpoints stay on screen while picking — the half-built route should
  // not vanish behind a text field.
  await expect(page.locator('#endpoints')).toBeVisible();
  await expect(page.locator('#suggest li.here')).toContainText(/your location/i);

  // The field must not move as the list grows under it.
  const before = await page.locator('#searchbar').boundingBox();
  await page.fill('#q', 'hall');
  await expect(page.locator('#suggest li').nth(2)).toBeVisible();
  const after = await page.locator('#searchbar').boundingBox();
  expect(Math.abs(after.y - before.y), 'search field stayed put while suggestions grew')
    .toBeLessThan(2);

  // And "Your location" steps aside once you have said what you are after.
  await expect(page.locator('#suggest li.here')).toHaveCount(0);
  await page.fill('#q', '');
  await expect(page.locator('#suggest li.here')).toHaveCount(1);

  await page.locator('#suggest li.here').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'directions');
  await expect(page.locator('#f-from span')).toContainText(/your location/i);
  await expect(page.locator('#d-go')).toBeEnabled();
  await expect(page.locator('#d-eta strong')).toHaveText(/\d+ min/);
});

test('a starting point can also be a building', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-directions').click();
  await page.locator('#f-from').click();
  await page.fill('#q', 'riley');
  await page.locator('#suggest li:not(.here)').first().click();
  await expect(page.locator('#f-from span')).toContainText(/riley/i);
  await expect(page.locator('#d-go')).toBeEnabled();
});

test('the walked part of the route greys out behind you', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();
  await page.fill('#q', 'plyler');
  await page.locator('#suggest li').first().click();
  await page.locator('#p-go').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'nav');

  const walkedLength = () => page.evaluate(() => {
    const s = window.__wayfinder.map.getSource('route-done');
    const d = s && s._data && (s._data.geojson || s._data);
    const c = d && d.geometry && d.geometry.coordinates;
    if (!c || c.length < 2) return 0;
    return turf.length(turf.lineString(c), { units: 'meters' });
  });

  // Nothing walked yet.
  expect(await walkedLength()).toBeLessThan(30);

  // Teleport a quarter of the way along the actual route and let it update.
  const quarter = await page.evaluate(() => {
    const { line, total } = window.__wayfinder.route;
    return turf.along(line, total * 0.25, { units: 'meters' }).geometry.coordinates;
  });
  await context.setGeolocation({ longitude: quarter[0], latitude: quarter[1] });
  await expect.poll(walkedLength, { timeout: 15000 }).toBeGreaterThan(40);

  // And the remaining distance shown must have fallen.
  await expect(page.locator('#n-eta span')).toContainText(/left/);
});

test('the search bar keeps the chosen place, and the cross clears everything @layout', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(MALL);
  await ready(page);
  await page.locator('#fab-locate').click();

  await page.fill('#q', 'riley');
  await page.locator('#suggest li:not(.here)').first().click();

  // The box names what the map is showing, rather than emptying itself.
  await expect(page.locator('#q')).toHaveValue(/riley/i);
  await expect(page.locator('#q-clear')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'place');

  await page.locator('#q-clear').click();

  // The cross undoes the search AND everything the search put on the map.
  await expect(page.locator('#q')).toHaveValue('');
  await expect(page.locator('#q-clear')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'browse');
  await expect(page.locator('#sheet')).not.toBeInViewport();
  const left = await page.evaluate(() => ({
    route: window.__wayfinder.map.queryRenderedFeatures({ layers: ['route-line'] }).length,
    highlighted: window.__wayfinder.highlighted.length
  }));
  expect(left, 'no route or highlighted building left behind').toEqual({ route: 0, highlighted: 0 });
});

test('tapping a building on the map also fills the search bar', async ({ page }) => {
  await ready(page);
  // A real click on the canvas. MapLibre dispatches layer handlers through its
  // own hit testing, so a synthetic fire() with a features array never reaches
  // map.on('click', 'buildings-fill', ...).
  await page.waitForFunction(() => window.__wayfinder.map?.isStyleLoaded?.(), null, { timeout: 20000 });
  const at = await page.evaluate(async () => {
    const w = window.__wayfinder, map = w.map;
    const f = w.places.find(p => /duke/i.test(p.properties.name));
    const c = turf.centroid(f).geometry.coordinates;
    map.jumpTo({ center: c, zoom: 18, pitch: 0, bearing: 0 });
    await new Promise(r => setTimeout(r, 900));
    const p = map.project(c);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
  await page.mouse.click(at.x, at.y);
  // However a place is chosen, the bar and the map must agree on what it is.
  await expect(page.locator('#q')).toHaveValue(/duke/i);
  await expect(page.locator('#q-clear')).toBeVisible();
});

test('selecting a place lights up the whole building', async ({ page }) => {
  await ready(page);
  await page.waitForFunction(() => window.__wayfinder.map?.isStyleLoaded?.(), null, { timeout: 20000 });
  await page.fill('#q', 'duke');
  await page.locator('#suggest li:not(.here)').first().click();

  const sel = await page.evaluate(() => {
    const w = window.__wayfinder;
    const chosen = w.places.find(p => p.id === w.highlighted[0]);
    return { count: w.highlighted.length, name: chosen && chosen.properties.name };
  });
  expect(sel.count, 'exactly one building highlighted').toBe(1);
  expect(sel.name).toMatch(/duke/i);

  // And it is genuinely painted, not just filtered in the abstract.
  await expect.poll(() => page.evaluate(() =>
    window.__wayfinder.map.queryRenderedFeatures({ layers: ['buildings-selected'] }).length),
    { timeout: 10000 }).toBeGreaterThan(0);
});

test('directions lights both ends when both are buildings', async ({ page }) => {
  await ready(page);
  await page.fill('#q', 'duke');
  await page.locator('#suggest li:not(.here)').first().click();
  await page.locator('#p-directions').click();
  await page.locator('#f-from').click();
  await page.fill('#q', 'riley');
  await page.locator('#suggest li:not(.here)').first().click();

  await expect.poll(() => page.evaluate(() => window.__wayfinder.highlighted.length),
    { timeout: 10000 }).toBe(2);
});

test('the sheet has its own dismiss, matching the search bar cross @layout', async ({ page }) => {
  await ready(page);
  await page.waitForFunction(() => window.__wayfinder.map?.isStyleLoaded?.(), null, { timeout: 20000 });
  await page.fill('#q', 'riley');
  await page.locator('#suggest li:not(.here)').first().click();
  await expect(page.locator('#p-close')).toBeVisible();

  await page.locator('#p-close').click();

  // Same outcome as the search bar cross: text, selection and highlight gone.
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'browse');
  await expect(page.locator('#q')).toHaveValue('');
  await expect(page.locator('#sheet')).not.toBeInViewport();
  expect(await page.evaluate(() => window.__wayfinder.highlighted.length)).toBe(0);

  // But it must NOT raise the keyboard over the map it just revealed.
  const focused = await page.evaluate(() => document.activeElement.id);
  expect(focused, 'focus should not jump into the search field').not.toBe('q');
});
