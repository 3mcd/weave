import "./polyfill"
import * as Signal from "./signal"

const IS_WORKER =
  typeof window === "undefined" ||
  // @ts-expect-error
  (typeof globalThis.WorkerGlobalScope !== "undefined" &&
    // @ts-expect-error
    self instanceof globalThis.WorkerGlobalScope)

type Sparse<T> = (T | undefined)[]
type ForEachCallback<T> = (value: T, key: number, registry: Registry<T>) => void

const STATE_OFFSET_VERSION = 0
const STATE_OFFSET_SIZE = 1
const STATE_OFFSET_LENGTH = 2
const STATE_OFFSET_GROW_THRESHOLD = 3
const STATE_OFFSET_GROW_TARGET = 4

/**
 * Calculate the ideal index for a key in the `Registry` map.
 */
function slot(k: number, n: number) {
  return n - (k % n)
}

async function acquireLockAsync(array: Int32Array, index: number) {
  let c: number
  if ((c = Atomics.compareExchange(array, index, 0, 1)) !== 0) {
    do {
      if (c === 2 || Atomics.compareExchange(array, index, 1, 2) !== 0)
        // @ts-expect-error
        await Atomics.waitAsync(array, index, 2, 100)
    } while ((c = Atomics.compareExchange(array, index, 0, 2)) !== 0)
  }
}

function acquireLockSync(array: Int32Array, index: number) {
  let c: number
  if ((c = Atomics.compareExchange(array, index, 0, 1)) !== 0) {
    do {
      if (c === 2 || Atomics.compareExchange(array, index, 1, 2) !== 0)
        Atomics.wait(array, index, 2)
    } while ((c = Atomics.compareExchange(array, index, 0, 2)) !== 0)
  }
}

function acquireLock(array: Int32Array, index = 0): Promise<void> | void {
  return (IS_WORKER ? acquireLockSync : acquireLockAsync)(array, index)
}

function releaseLock(array: Int32Array, index = 0) {
  let v0 = Atomics.sub(array, index, 1)
  if (v0 !== 1) {
    Atomics.store(array, index, 0)
    Atomics.notify(array, index, 1)
  }
}

export class Registry<T> {
  #lock: Int32Array = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

  /**
   * `[version, size, length, grow_threshold, grow_target]`
   */
  #state: Uint32Array = new Uint32Array(
    new SharedArrayBuffer(5 * Uint32Array.BYTES_PER_ELEMENT),
  )

  /**
   * Sparse TypedArray that maps keys to their offset in the dense arrays.
   */
  #sparse: Float64Array

  /**
   * Dense TypedArray that maps values to their offset in the sparse arrays.
   */
  #dense: Float64Array

  /**
   * Sparse TypedArray of keys.
   */
  #keys: Float64Array

  /**
   * Sparse TypedArray of entry versions.
   */
  #versions: Uint32Array

  /**
   * Sparse TypedArray of entry lock bits.
   */
  #entryLock: Int32Array

  /**
   * Dense array of local map values.
   */
  #values: T[] = []

  /**
   * A sparse array of deferred promises to be resolved when their guarantee
   * is executed (upon recieving the latest entry version from another thread).
   */
  #guarantors: Sparse<Promise<number>> = []

  /**
   * A sparse array of resolve functions that will resolve a deferred promise
   * at the corresponding index in the guarantors array.
   */
  #guarantees: Sparse<(value: number) => void> = []

  #localVersion = 0

  /**
   * Sparse array of local entry versions.
   */
  #localEntryVersions: number[] = []

  #loadFactor: number = 0.7

  #growFactor: number = 2

  onGrow = Signal.make()

  onShare = Signal.make<[key: number, value: T, version: number]>()

  constructor(length = 1000, loadFactor?: number, growFactor?: number) {
    this.#loadFactor = loadFactor ?? this.#loadFactor
    this.#growFactor = growFactor ?? this.#growFactor
    this.#sparse = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#dense = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#keys = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#versions = new Uint32Array(
      new SharedArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT),
    )
    this.#entryLock = new Int32Array(
      new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT),
    )
    this.#state[STATE_OFFSET_LENGTH] = length
    this.#state[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#state[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor
  }

  #grow() {}

  async #check() {
    await acquireLock(this.#lock)
    if (this.#state[STATE_OFFSET_VERSION] > this.#localVersion) {
      // wait for resized registry arrays
    }
    if (this.#state[STATE_OFFSET_SIZE] === this.#state[STATE_OFFSET_GROW_TARGET]) {
      this.#grow()
    }
    releaseLock(this.#lock)
  }

  #find(key: number) {
    let length = this.#state[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    while (true) {
      let s = offset % length
      if (this.#keys[s] === key) return s
      offset++
    }
  }

  async #acquire(key: number) {
    let length = this.#state[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    while (true) {
      let s = offset % length
      await acquireLock(this.#entryLock, s)
      if (this.#keys[s] === key || this.#keys[s] === 0) return this.#ensure(s)
      releaseLock(this.#entryLock, s)
      offset++
    }
  }

  async #findAndAcquire(key: number) {
    let length = this.#state[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    let end = offset + length
    while (offset < end) {
      let s = offset % length
      await acquireLock(this.#entryLock, s)
      if (this.#keys[s] === key) return this.#ensure(s)
      releaseLock(this.#entryLock, s)
      offset++
    }
    return -1
  }

  async #ensure(s: number, v0 = this.#localEntryVersions[s]): Promise<number> {
    if (v0 < this.#versions[s]) {
      let p = this.#guarantors[s]
      if (p === undefined) {
        p = new Promise(resolve => (this.#guarantees[s] = resolve))
        this.#guarantors[s] = p
      }
      return p.then(v2 => (v2 < v0 ? this.#ensure(s, v0) : s))
    }
    return Promise.resolve(s)
  }

  async acquire(key: number) {
    let s = await this.#findAndAcquire(key)
    if (s === -1) return undefined
    return this.#values[this.#sparse[s]]
  }

  async release(key: number) {
    let s = await this.#findAndAcquire(key)
    if (s === -1) return false
    releaseLock(this.#entryLock, s)
    return true
  }

  #set(key: number, s: number, value: T, v?: number) {
    let d: number
    if (v === undefined || v === 0) {
      d = this.#state[STATE_OFFSET_SIZE]++
      this.#keys[s] = key
      this.#sparse[s] = d
      this.#dense[d] = s
    } else {
      d = this.#sparse[s]
    }
    this.#values[d] = value
    this.#localEntryVersions[s] = ++this.#versions[s]
  }

  async set(key: number, value: T) {
    let s = await this.#acquire(key)
    let v = this.#versions[s]
    this.#set(key, s, value, v)
    releaseLock(this.#entryLock, s)
    Signal.dispatch(this.onShare, [key, value, this.#localEntryVersions[s]])
  }

  async recieve(key: number, value: T, version: number) {
    let s = await this.#acquire(key)
    let v = this.#localEntryVersions[s]
    let g = this.#guarantees[s]
    if (v === undefined) {
      this.#set(key, s, value, v)
    } else if (version > v) {
      this.#values[this.#sparse[s]] = value
    }
    g?.(version)
    releaseLock(this.#entryLock, s)
  }

  get size() {
    return this.#state[STATE_OFFSET_SIZE]
  }

  async has(key: number) {
    return this.#find(key) > 0
  }

  async delete(key: number) {
    if (!this.has(key)) return false
    let s = await this.#acquire(key)
    let d = this.#sparse[s]
    this.#sparse[s] = 0
    this.#dense[d] = 0
    this.#keys[s] = 0
    this.#localEntryVersions[s] = this.#versions[s] = 0
    // @ts-expect-error
    this.#values[s] = undefined
    this.#state[STATE_OFFSET_SIZE]--
    releaseLock(this.#entryLock, s)
    return true
  }

  async clear() {
    let size = this.#state[STATE_OFFSET_SIZE]
    let promises: Promise<unknown>[] = []
    for (let d = 0; d < size; d++) {
      promises.push(this.delete(this.#sparse[this.#dense[d]]))
    }
    await Promise.all(promises)
  }

  forEach(iteratee: ForEachCallback<T>, thisArg?: any) {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let d = 0; d < size; d++) {
      iteratee.call(thisArg, this.#values[d]!, this.#sparse[this.#dense[d]], this)
    }
  }

  *entries(): IterableIterator<[number, T]> {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let d = 0; d < size; d++) {
      yield [this.#sparse[this.#dense[d]], this.#values[d]!]
    }
  }

  *keys(): IterableIterator<number> {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let d = 0; d < size; d++) {
      yield this.#sparse[this.#dense[d]]
    }
  }

  *values(): IterableIterator<T> {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let d = 0; d < size; d++) {
      yield this.#values[d]
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  get [Symbol.toStringTag]() {
    return "Registry"
  }
}
