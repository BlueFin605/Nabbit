import { defineConfig, devices } from '@playwright/test';
import { ports } from './scripts/ports.mjs';

// Assumes the stack is already up (`npm run stack:up -w e2e`); see e2e/README.md. Ports are env-driven
// (E2E_FRONTEND_PORT etc.) and shared with scripts/stack.mjs through scripts/ports.mjs.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // One shared dev user (the frontend's mock token is a fixed sub), so tests run serially and clean up
  // that user's data through the API before each test.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${ports.frontend}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-pixel7' }],
});
