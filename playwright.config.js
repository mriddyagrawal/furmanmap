// Playwright drives a real browser against the real static site — the same way
// a phone does. The unit tests in tests/*.test.js cover graph.js; everything in
// app.js is DOM and was, until now, tested only by hand on a phone.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  // Each spec holds a live WebGL map. Too many at once starve the compositor,
  // which makes animation-timing assertions measure machine load rather than
  // the animation. Capping workers is the honest fix; weakening the assertion
  // would just hide the flake.
  workers: process.env.CI ? 2 : 3,
  retries: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:8765',
    trace: 'retain-on-failure',
    // MapLibre needs WebGL; headless Chromium provides it through SwiftShader.
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }
  },
  projects: [
    // Everything runs on a phone, because that is what this is for.
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    // Desktop repeats only the tests whose result can actually differ with the
    // viewport. Running all 79 twice doubled the suite to catch layout bugs
    // that a routing or contrast test was never going to find either way.
    { name: 'desktop', grep: /@layout/, use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'python3 -m http.server 8765',
    url: 'http://localhost:8765/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 20000
  }
});
