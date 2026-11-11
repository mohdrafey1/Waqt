import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.json' },
        miniflare: {
          // Fixed values so tests never depend on a local .dev.vars file.
          bindings: {
            TEST_MIGRATIONS: migrations,
            API_KEY: '0f8fad5b-d9cb-469f-a165-70867728950e',
            WAKATIME_API_KEY: '',
            WAKATIME_API_URL: '',
            WAKATIME_IMPORT_URL: '',
            TELEGRAM_API_URL: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
