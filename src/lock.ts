const SUPPORTS_BLOCKING_WAIT =
  typeof window === "undefined" ||
  // @ts-expect-error
  (typeof globalThis.WorkerGlobalScope !== "undefined" &&
    // @ts-expect-error
    self instanceof globalThis.WorkerGlobalScope)

export async function acquireLockAsync(array: Int32Array, index: number) {
  let c: number
  if ((c = Atomics.compareExchange(array, index, 0, 1)) !== 0) {
    do {
      if (c === 2 || Atomics.compareExchange(array, index, 1, 2) !== 0)
        // @ts-expect-error
        await Atomics.waitAsync(array, index, 2, 100)
    } while ((c = Atomics.compareExchange(array, index, 0, 2)) !== 0)
  }
}

export function acquireLockSync(array: Int32Array, index: number) {
  let c: number
  if ((c = Atomics.compareExchange(array, index, 0, 1)) !== 0) {
    do {
      if (c === 2 || Atomics.compareExchange(array, index, 1, 2) !== 0)
        Atomics.wait(array, index, 2)
    } while ((c = Atomics.compareExchange(array, index, 0, 2)) !== 0)
  }
}

export function acquireLock(array: Int32Array, index = 0): Promise<void> | void {
  return (SUPPORTS_BLOCKING_WAIT ? acquireLockSync : acquireLockAsync)(array, index)
}

export function releaseLock(array: Int32Array, index = 0) {
  let v0 = Atomics.sub(array, index, 1)
  if (v0 !== 1) {
    Atomics.store(array, index, 0)
    Atomics.notify(array, index, 1)
  }
}
