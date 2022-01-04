import "./polyfill"

const IS_WORKER =
  typeof window === "undefined" ||
  // @ts-expect-error
  (typeof globalThis.WorkerGlobalScope !== "undefined" &&
    // @ts-expect-error
    self instanceof globalThis.WorkerGlobalScope)

const SPARSE_SIZE = 0
const SPARSE_LIMIT = 1
const SPARSE_TARGET = 2
const SPARSE_ENTRY_START = SPARSE_TARGET + 1
const SPARSE_OFFSET_KEY = 1
const SPARSE_OFFSET_LOCK = 2
const SPARSE_ENTRY_SIZE = 3
const DENSE_OFFSET_VERSION = 1
const DENSE_ENTRY_SIZE = 2

function calcSlot(k: number, n: number) {
  // Slightly faster than (k % n)
  return n - (k % n)
}

type Sparse<T> = (T | undefined)[]
type OnPublishCallback<T> = (key: number, value: T, version: number) => void
type ForEachCallback<T> = (value: T, key: number, registry: Registry<T>) => void

/**
 * A data structure that provides the means to share serializable JS objects
 * between threads by:
 * - Exposing methods to safely acquire and release objects keyed by 52-bit
 * unsigned integers.
 * - Forcing concurrent threads to wait (in a blocking manner) until acquired
 * objects are released.
 * - Assigning an auto-incrementing version number to values, and forcing
 * concurrent threads to wait (in a non-blocking manner) until their local
 * version matches the latest version.
 *
 * This library was built to orchestrate the resizing of `SharedArrayBuffers`
 * in threaded JS programs, but can used for any object type.
 *
 * Will (hopefully) be made obsolete by https://github.com/tc39/proposal-resizablearraybuffer
 */
export class Registry<T> {
  /**
   * `Registry` is essentially a sparse set implemented using two
   * `SharedArrayBuffers`, which allocate shared memory for:
   * - a sparse array of flattened pairs of `(dense_index, key, lock)`, where
   * `lock` is a bit that signifies the object is in use by a thread
   * - a dense array of flattened tuple of `(sparse_index, version)`, where
   * `version` is the latest version of that object.
   *
   * An example sparse set with a single entry would look something like:
   *
   * ```
   * Float64Array [0, 123, 1] // sparse (dense_index, key, lock)
   * Float64Array [0, 1, 7] // dense (sparse_index, version)
   * ```
   *
   * In the above example, `Registry` has stored a single entry with key `123`.
   * This entry is in use by a thread and has been changed (set) 7 times.
   *
   * `Registry` can support any 52-bit unsinged integer as a key. In a normal JS
   * context we could simply use an object or sparse array to quickly create an
   * entry with a (potentially huge) integer key, e.g. `arr[2 ** 52] = 1`. But
   * since `Registry` uses fixed-length `ArrayBuffer`s, we can't pre-allocate
   * an array for the entire dodmain of 52 bit integers. Instead, a simple
   * hashing (modulo) function is used to calculate the offset of a key within
   * a much smaller domain.
   *
   * The sparse array also serves double-duty by storing the current registry
   * size, upper limit of entries before next grow (calculated using a
   * configurable load factor), and a pre-computed size for the registry after
   * the next grow.
   *
   */
  #sparse: Float64Array
  #dense: Float64Array
  #lock: Int32Array
  #values: Sparse<T> = []
  #versions: Sparse<number> = []
  #guarantors: Sparse<Promise<never>> = []
  #guarantees: Sparse<Function> = []
  #onPublish: OnPublishCallback<T>

  constructor(length: number, onPublish: OnPublishCallback<T>) {
    let abSparse = new SharedArrayBuffer(
      (length * SPARSE_ENTRY_SIZE + SPARSE_ENTRY_START) * Float64Array.BYTES_PER_ELEMENT,
    )
    let abDense = new SharedArrayBuffer(
      length * DENSE_ENTRY_SIZE * Float64Array.BYTES_PER_ELEMENT,
    )
    this.#sparse = new Float64Array(abSparse)
    this.#sparse[SPARSE_LIMIT] = length
    this.#lock = new Int32Array(abSparse)
    this.#dense = new Float64Array(abDense)
    this.#onPublish = onPublish
  }

  async #locate(key: number) {
    let limit = this.#sparse[SPARSE_LIMIT]
    let offset = calcSlot(key, limit) * SPARSE_ENTRY_SIZE
    let length = limit * SPARSE_ENTRY_SIZE

    while (true) {
      let s = SPARSE_ENTRY_START + (offset % length)
      await this.#acquire(s)
      let k = this.#sparse[s + SPARSE_OFFSET_KEY]
      if (k === key) {
        this.#release(s)
        return s
      }
      if (k === 0) {
        this.#release(s)
        return -1
      }
      offset += SPARSE_ENTRY_SIZE
    }
  }

  async #acquireAsync(i: number) {
    let c: number
    if ((c = Atomics.compareExchange(this.#lock, i, 0, 1)) !== 0) {
      do {
        if (c === 2 || Atomics.compareExchange(this.#lock, i, 1, 2) !== 0)
          // @ts-expect-error
          await Atomics.waitAsync(this.#lock, i, 2, 100)
      } while ((c = Atomics.compareExchange(this.#lock, i, 0, 2)) !== 0)
    }
  }

  async #acquireSync(i: number) {
    let c: number
    if ((c = Atomics.compareExchange(this.#lock, i, 0, 1)) !== 0) {
      do {
        if (c === 2 || Atomics.compareExchange(this.#lock, i, 1, 2) !== 0)
          Atomics.wait(this.#lock, i, 2)
      } while ((c = Atomics.compareExchange(this.#lock, i, 0, 2)) !== 0)
    }
  }

  async #acquire(s: number) {
    let i = s + SPARSE_OFFSET_LOCK
    return IS_WORKER ? this.#acquireSync(i) : this.#acquireAsync(i)
  }

  #release(s: number) {
    let i = s + SPARSE_OFFSET_LOCK
    let v0 = Atomics.sub(this.#lock, i, 1)
    if (v0 !== 1) {
      Atomics.store(this.#lock, i, 0)
      Atomics.notify(this.#lock, i, 1)
    }
  }

  async #ensure(d: number) {
    let v = this.#dense[d * DENSE_ENTRY_SIZE + DENSE_OFFSET_VERSION]
    if (v !== this.#versions[d]) {
      let promise = this.#guarantors[d]
      if (promise === undefined) {
        promise = new Promise(resolve => (this.#guarantees[d] = resolve))
        this.#guarantors[d] = promise
      }
      return promise
    }
    return Promise.resolve()
  }

  #publish(key: number, value: T, version: number) {
    this.#onPublish(key, value, version)
  }

  async recieve(key: number, version: number, value: T) {
    let limit = this.#sparse[SPARSE_LIMIT]
    let offset = calcSlot(key, limit) * SPARSE_ENTRY_SIZE
    let length = limit * SPARSE_ENTRY_SIZE

    while (true) {
      let s = SPARSE_ENTRY_START + (offset % length)
      let k = this.#sparse[s + SPARSE_OFFSET_KEY]
      await this.#acquire(s)

      if (k === 0) {
        // No entry exists for this key, create it!
        return this.set(key, value, version)
      }

      if (k === key) {
        let d: number = this.#sparse[s]
        // Update the local version
        this.#versions[d] = version
        // Overwrite the local thread's entry value
        this.#values[d] = value
        // Execute any pending guarantees (deferred promises created due to version
        // mismatch) for this entry
        this.#guarantees[d]?.()
        this.#release(s)
        return
      }

      offset += SPARSE_ENTRY_SIZE
      this.#release(s)
    }
  }

  async set(key: number, value: T, version?: number) {
    let limit = this.#sparse[SPARSE_LIMIT]
    let offset = calcSlot(key, limit) * SPARSE_ENTRY_SIZE
    let length = limit * SPARSE_ENTRY_SIZE

    while (true) {
      let s = SPARSE_ENTRY_START + (offset % length)
      let k = this.#sparse[s + SPARSE_OFFSET_KEY]
      let v: number
      let d: number

      await this.#acquire(s)
      if (k === key) {
        // update
        d = this.#sparse[s]
        v = this.#versions[d] = version ?? this.#dense[d + DENSE_OFFSET_VERSION]++
      } else if (k === 0) {
        // insert
        d = this.#sparse[SPARSE_SIZE]++
        v = this.#versions[d] = 1
        this.#sparse[s] = d
        this.#sparse[s + SPARSE_OFFSET_KEY] = key
        this.#sparse[s + SPARSE_OFFSET_LOCK] = 0
        this.#dense[d * DENSE_ENTRY_SIZE] = s
        this.#dense[d * DENSE_ENTRY_SIZE + DENSE_OFFSET_VERSION] = 1
      } else {
        offset += SPARSE_ENTRY_SIZE
        this.#release(s)
        continue
      }

      this.#values[d] = value
      this.#publish(key, value, v)
      this.#release(s)
      return this
    }
  }

  async has(key: number) {
    return (await this.#locate(key)) > -1
  }

  async get(key: number): Promise<T> {
    setImmediate(() => this.release(key))
    return this.acquire(key)
  }

  async acquire(key: number): Promise<T> {
    let s = await this.#locate(key)
    let d = this.#sparse[s]
    await this.#acquire(s)
    await this.#ensure(d)
    let value = this.#values[d]
    if (value === undefined) throw new Error("AHH!")
    return value
  }

  async release(key: number) {
    let s = await this.#locate(key)
    this.#release(s)
  }

  get size() {
    return this.#sparse[SPARSE_SIZE]
  }

  async clear() {
    let size = this.#sparse[SPARSE_SIZE]
    let promises: Promise<unknown>[] = []
    for (let i = 0; i < size; i += 2) {
      promises.push(this.delete(this.#sparse[this.#dense[i]]))
    }
    await Promise.all(promises)
  }

  async delete(key: number) {
    if (!this.has(key)) return false
    let s = await this.#locate(key)
    let d = this.#sparse[s]
    await this.#acquire(d)
    this.#sparse[s] = 0
    this.#sparse[s + SPARSE_OFFSET_KEY] = key
    this.#sparse[s + SPARSE_OFFSET_LOCK] = 0
    this.#dense[d * DENSE_ENTRY_SIZE] = 0
    this.#dense[d * DENSE_ENTRY_SIZE + DENSE_OFFSET_VERSION] = 0
    this.#release(d)
    return true
  }

  forEach(iteratee: ForEachCallback<T>, thisArg?: any) {
    let size = this.#sparse[SPARSE_SIZE]
    for (let d = 0; d < size; d++) {
      iteratee(this.#values[d]!, this.#sparse[this.#dense[d * DENSE_ENTRY_SIZE]], this)
    }
  }

  *entries(): IterableIterator<[number, T]> {
    let size = this.#sparse[SPARSE_SIZE]
    for (let d = 0; d < size; d++) {
      yield [this.#sparse[this.#dense[d * DENSE_ENTRY_SIZE]], this.#values[d]!]
    }
  }

  *keys(): IterableIterator<number> {
    let size = this.#sparse[SPARSE_SIZE]
    for (let d = 0; d < size; d++) {
      yield this.#sparse[this.#dense[d * DENSE_ENTRY_SIZE]]
    }
  }

  *values(): IterableIterator<T> {
    let size = this.#sparse[SPARSE_SIZE]
    for (let d = 0; d < size; d++) {
      yield this.#values[d * DENSE_ENTRY_SIZE]!
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  get [Symbol.toStringTag]() {
    return "Registry"
  }
}
