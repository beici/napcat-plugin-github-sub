import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 测试里会读写临时目录，串行跑更稳定
    fileParallelism: false,
  },
});
