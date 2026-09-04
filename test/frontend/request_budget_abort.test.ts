let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

async function run() {
  (globalThis as { navigator?: unknown }).navigator = {};
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    queueMicrotask(callback);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    const { runLowPriority, setPlaybackActive } = await import("../../web/src/lib/requestBudget");
    setPlaybackActive(true);
    let observedSignal: AbortSignal | undefined;
    const pending = runLowPriority((signal) => {
      observedSignal = signal;
      return new Promise<void>(() => {});
    });
    let rejected = false;
    await pending.catch(() => { rejected = true; });
    assert(observedSignal?.aborted, "budget deadline aborts the work signal");
    assert(rejected, "budget deadline settles the caller promise");
    setPlaybackActive(false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
