// Resolve only the app-provided module; React/jsdom come from npm ci.
export function resolve(specifier, context, nextResolve) {
  if (specifier === '@hermes/plugin-sdk') {
    return { shortCircuit: true, url: new URL('./sdk-stub.mjs', import.meta.url).href }
  }
  return nextResolve(specifier, context)
}
