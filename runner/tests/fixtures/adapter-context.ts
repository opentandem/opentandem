// Adapter context for tests: the real adapter factory plus a set of Runner capabilities that is only enough to parse and build commands.
// Any capability not listed is a function that does nothing; tests replace it with their own implementation via overrides when needed.
import { createAdapters } from '../../adapters/index.mjs'
import { createAdapterTranslator } from '../../core/messages.mjs'

export function stubAdapterContext(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    config: () => undefined,
    configKey: (key: string) => key,
    t: createAdapterTranslator(),
    sessionImport: {},
    runtimeInstructions: () => 'rules',
    toolServerSpec: () => ({}),
    runnerCommand: (sub: string) => `"/bin/node" "/runner/machine-daemon.mjs" ${sub}`,
    VERSION_PROBE_MS: 1000,
    modelProbeCwd: '/tmp',
    runnerVersion: 'test',
    titleTimeoutMs: 1000,
    ...overrides,
  }
  return new Proxy(base, {
    get: (target, key) => (typeof key === 'symbol' || key in target ? target[key as string] : () => undefined),
  })
}

export function stubAdapters(overrides: Record<string, unknown> = {}) {
  return createAdapters(stubAdapterContext(overrides))
}
