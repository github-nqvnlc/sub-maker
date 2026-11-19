import fs from 'node:fs';
import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL && fs.existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema/index.ts',
  out: './src/lib/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://invalid' },
  strict: true,
});
