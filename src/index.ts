import "./polyfill"
import * as Debug from "./debug"
import * as Signal from "./signal"
import { Guarantor } from "./guarantor"

const SUPPORTS_BLOCKING_WAIT =
  typeof window === "undefined" ||
  // @ts-expect-error
  (typeof globalThis.WorkerGlobalScope !== "undefined" &&
    // @ts-expect-error
    self instanceof globalThis.WorkerGlobalScope)

type Version = number
type Sparse<T> = (T | undefined)[]
type ForEachCallback<T> = (value: T, key: number, registry: Registry<T>) => void

enum MessageType {
  Share,
  State,
}

type ShareMessage = [
  type: MessageType.Share,
  key: number,
  value: unknown,
  version: number,
]

type StateMessage = [
  type: MessageType.State,
  version: number,
  sparse: Float64Array,
  packed: Float64Array,
  keys: Float64Array,
  versions: Uint32Array,
  entryLock: Int32Array,
]

type Message = ShareMessage | StateMessage

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
  return (SUPPORTS_BLOCKING_WAIT ? acquireLockSync : acquireLockAsync)(array, index)
}

function releaseLock(array: Int32Array, index = 0) {
  let v0 = Atomics.sub(array, index, 1)
  if (v0 !== 1) {
    Atomics.store(array, index, 0)
    Atomics.notify(array, index, 1)
  }
}

class SharedGuarantor extends Guarantor<Version> {
  #shared: Uint32Array
  #index: number

  constructor(shared: Uint32Array, index: number) {
    super(0)
    this.#shared = shared
    this.#index = index
  }

  filter(version: Version) {
    return version === this.#shared[this.#index]
  }

  isInvalid() {
    return this.latest < this.#shared[this.#index]
  }
}

function incrementVersion(guarantor: Guarantor<Version>) {
  guarantor.update(guarantor.latest + 1)
}

export class Registry<T> {
  #lock: Int32Array = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

  /**
   * `[version, size, length, grow_threshold, grow_target]`
   */
  #state: Uint32Array = new Uint32Array(
    new SharedArrayBuffer(5 * Uint32Array.BYTES_PER_ELEMENT),
  )

  #guarantor = new SharedGuarantor(this.#state, STATE_OFFSET_VERSION)

  /**
   * Sparse TypedArray that maps keys to their offset in the packed arrays.
   */
  #sparse: Float64Array

  /**
   * Dense TypedArray that maps values to their offset in the sparse arrays.
   */
  #packed: Float64Array

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
  #locks: Int32Array

  /**
   * Dense array of local map values.
   */
  #values: T[] = []

  /**
   * A sparse array of deferred promises to be resolved when their guarantee
   * is executed (upon recieving the latest entry version from another thread).
   */
  #guarantors: Sparse<SharedGuarantor> = []

  #loadFactor: number = 0.7
  #growFactor: number = 2

  onState = Signal.make<StateMessage>()
  onShare = Signal.make<ShareMessage>()

  constructor(length = 1000, loadFactor?: number, growFactor?: number) {
    this.#loadFactor = loadFactor ?? this.#loadFactor
    this.#growFactor = growFactor ?? this.#growFactor
    this.#sparse = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#packed = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#keys = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#versions = new Uint32Array(
      new SharedArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT),
    )
    this.#locks = new Int32Array(
      new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT),
    )
    this.#state[STATE_OFFSET_LENGTH] = length
    this.#state[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#state[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor
  }

  async #grow() {
    let entryLock = this.#locks
    let packed = this.#packed
    let keys = this.#keys
    let values = this.#values
    let { [STATE_OFFSET_SIZE]: size, [STATE_OFFSET_GROW_TARGET]: length } = this.#state

    incrementVersion(this.#guarantor)

    this.#sparse = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#packed = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#keys = new Float64Array(
      new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT),
    )
    this.#versions = new Uint32Array(
      new SharedArrayBuffer(length * Uint32Array.BYTES_PER_ELEMENT),
    )
    this.#locks = new Int32Array(
      new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT),
    )
    this.#state[STATE_OFFSET_LENGTH] = length
    this.#state[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#state[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor

    for (let p = 0; p < size; p++) {
      let s = packed[p]
      await acquireLock(entryLock, s)
      await this.#set(keys[s], s, values[p])
      releaseLock(entryLock, s)
    }

    Signal.dispatch(this.onState, [
      MessageType.State,
      this.#guarantor.latest ?? 0,
      this.#sparse,
      this.#packed,
      this.#keys,
      this.#versions,
      entryLock,
    ])
  }

  async #ensureRegistry() {
    // Acquire a lock on the entire registry
    await acquireLock(this.#lock)
    await this.#guarantor.guarantee()
    if (this.#state[STATE_OFFSET_SIZE] >= this.#state[STATE_OFFSET_GROW_THRESHOLD]) {
      await this.#grow()
    }
    releaseLock(this.#lock)
  }

  /**
   * Find the offset of an existing key in the registry. Returns -1 if an
   * entry with the provided key does not exist.
   */
  #locate(key: number) {
    let length = this.#state[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    let end = offset + length
    while (offset < end) {
      let s = offset % length
      if (this.#keys[s] === key) return s
      offset++
    }
    return -1
  }

  /**
   * Find the offset for a key in the registry. If an existing or available
   * index is found, `acquire` will immediately acquire a lock on that index.
   * Returns -1 if no available index is found.
   */
  async #acquire(key: number) {
    let length = this.#state[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    let end = offset + length
    while (offset < end) {
      let s = offset % length
      await acquireLock(this.#locks, s)
      if (this.#keys[s] === key || this.#keys[s] === 0) {
        return this.#ensureEntry(s)
      }
      releaseLock(this.#locks, s)
      offset++
    }
    return -1
  }

  /**
   * Ensure this thread has the latest version of an entry. Returns a promise
   * that resolves only
   */
  async #ensureEntry(s: number): Promise<number> {
    await (await this.#getOrMakeGuarantor(s)).guarantee()
    return s
  }

  async #getOrMakeGuarantor(s: number) {
    return (
      this.#guarantors[s] ??
      (this.#guarantors[s] = new SharedGuarantor(this.#versions, s))
    )
  }

  async #set(key: number, s: number, value: T, version?: number) {
    let guarantor = await this.#getOrMakeGuarantor(s)
    let p: number
    if (version === undefined || version === 0) {
      p = this.#state[STATE_OFFSET_SIZE]++
      this.#keys[s] = key
      this.#packed[p] = s
      this.#sparse[s] = p
    } else {
      p = this.#sparse[s]
    }
    guarantor.update(++this.#versions[s])
    this.#values[p] = value
  }

  async acquire(key: number) {
    let s = await this.#acquire(key)
    if (s === -1) return undefined
    return this.#values[this.#sparse[s]]
  }

  async release(key: number) {
    let s = await this.#acquire(key)
    if (s === -1) return false
    releaseLock(this.#locks, s)
    return true
  }

  async set(key: number, value: T) {
    await this.#ensureRegistry()
    let s = await this.#acquire(key)
    Debug.assert(s > -1)
    let version = this.#versions[s]
    await this.#set(key, s, value, version)
    releaseLock(this.#locks, s)
    Signal.dispatch(this.onShare, [
      0,
      key,
      value,
      (await this.#getOrMakeGuarantor(s)).latest,
    ])
    return this
  }

  async recieve(message: Message) {
    switch (message[0]) {
      case 0: {
        const [, key, value, version] = message
        let s = await this.#acquire(key)
        Debug.assert(s > -1)
        let guarantor = await this.#getOrMakeGuarantor(s)
        let localVersion = guarantor.latest
        if (localVersion === 0) {
          await this.#set(key, s, value as T, localVersion)
        } else if (version > localVersion) {
          this.#values[this.#sparse[s]] = value as T
        }
        guarantor.update(version)
        releaseLock(this.#locks, s)
        break
      }
      case 1: {
        const [, version, sparse, packed, keys, versions, entryLock] = message
        this.#sparse = sparse
        this.#packed = packed
        this.#keys = keys
        this.#versions = versions
        this.#locks = entryLock
        this.#guarantor.update(version)
      }
    }
  }

  get size() {
    return this.#state[STATE_OFFSET_SIZE]
  }

  async has(key: number) {
    return this.#locate(key) > 0
  }

  async delete(key: number) {
    if (!this.has(key)) return false
    let s = await this.#acquire(key)
    let p = this.#sparse[s]
    let guarantor = await this.#getOrMakeGuarantor(s)
    guarantor.update(0)
    this.#sparse[s] = 0
    this.#packed[p] = 0
    this.#keys[s] = 0
    // @ts-expect-error
    this.#values[s] = undefined
    this.#state[STATE_OFFSET_SIZE]--
    releaseLock(this.#locks, s)
    return true
  }

  async clear() {
    await this.#ensureRegistry()
    let size = this.#state[STATE_OFFSET_SIZE]
    let promises: Promise<unknown>[] = []
    for (let p = 0; p < size; p++) {
      promises.push(this.delete(this.#sparse[this.#packed[p]]))
    }
    await Promise.all(promises)
  }

  forEach(iteratee: ForEachCallback<T>, thisArg?: any) {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let p = 0; p < size; p++) {
      iteratee.call(thisArg, this.#values[p]!, this.#sparse[this.#packed[p]], this)
    }
  }

  *entries(): IterableIterator<[number, T]> {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let p = 0; p < size; p++) {
      yield [this.#sparse[this.#packed[p]], this.#values[p]!]
    }
  }

  *keys(): IterableIterator<number> {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let p = 0; p < size; p++) {
      yield this.#sparse[this.#packed[p]]
    }
  }

  *values(): IterableIterator<T> {
    let size = this.#state[STATE_OFFSET_SIZE]
    for (let p = 0; p < size; p++) {
      yield this.#values[p]
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  get [Symbol.toStringTag]() {
    return "Registry"
  }
}
