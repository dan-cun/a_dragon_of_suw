import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'work/test-results',
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' }
});
