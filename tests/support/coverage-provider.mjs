// Custom coverage provider module: @vitest/coverage-v8, made accurate for the
// extension's classic scripts. See classic-scripts.mjs for the why.
//
// The worker-side half (start/take/stop coverage over the inspector) is the stock v8
// module, untouched. Only getProvider() differs: it returns a V8CoverageProvider
// subclass, loaded lazily because the provider pulls in vitest/node and the report
// libraries, which have no business in a test worker.

import v8 from '@vitest/coverage-v8';

export default {
  ...v8,
  async getProvider() {
    const { createClassicAwareProvider } = await import('./coverage-provider-impl.mjs');
    return createClassicAwareProvider();
  },
};
