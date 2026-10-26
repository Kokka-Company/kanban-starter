/**
 * Adapt console, an Azure Functions InvocationContext, or a bare function into { log, warn, error }.
 * Methods are called ON the original object: InvocationContext.log relies on `this` and throws
 * when detached (console doesn't care, which is why this only ever broke in Azure).
 */
export function normalizeLogger(logger) {
  const base = logger || console
  if (typeof base === 'function') return { log: base, warn: base, error: base }
  const log = (...a) => (base.log || base.info).apply(base, a)
  return {
    log,
    warn: (...a) => (base.warn ? base.warn.apply(base, a) : log(...a)),
    error: (...a) => (base.error ? base.error.apply(base, a) : log(...a)),
  }
}
