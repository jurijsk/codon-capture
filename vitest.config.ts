import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// The loader's test opts into jsdom with a `// @vitest-environment jsdom` docblock.
		environment: 'node',
	},
});
