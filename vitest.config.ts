import path from 'node:path';
import { defineConfig } from 'vitest/config';

const alias = { '@': path.resolve(import.meta.dirname, 'src') };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
          globalSetup: ['tests/integration/globalSetup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Các test dùng chung một CSDL/MinIO thật nên chạy tuần tự giữa các file.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'isolation',
          include: ['tests/isolation/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
          globalSetup: ['tests/integration/globalSetup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
