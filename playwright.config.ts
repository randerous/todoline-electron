import { defineConfig } from '@playwright/test';
// Test output goes under the checkout by default; on Windows CI the deep
// "test-results/<test title>/workspace/profile/recovery/..." tree pushes the
// app's recovery backup past MAX_PATH (260), where SQLite reports
// "unable to open database file". CI points this at a short directory instead.
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || undefined;
export default defineConfig({testDir:'./tests/e2e',...(outputDir?{outputDir}:{}),timeout:45000,workers:1,fullyParallel:false,use:{trace:'retain-on-failure',screenshot:'only-on-failure'},reporter:[['list'],['html',{open:'never'}]]});
