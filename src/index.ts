import "./polyfill"
import * as Debug from "./debug"
import * as Signal from "./signal"
import { KeyPairSyncResult } from "crypto"

const IS_WORKER =
  typeof window === "undefined" ||
  // @ts-expect-error
  (typeof globalThis.WorkerGlobalScope !== "undefined" &&
    // @ts-expect-error
    self instanceof globalThis.WorkerGlobalScope)

type Sparse<T> = (T | undefined)[]
type ForEachCallback<T> = (value: T, key: number, registry: Registry<T>) => void

type ShareMessage = [type: 0, key: number, value: unknown, version: number]
type StateMessage = [type: 1, sparse: Float64Array, packed: Float64Array, keys: Float64Array, versions: Uint32Array, entryLock: Int32Array]
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
  #registryLock: Int32Array = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

  /**
   * `[version, size, length, grow_threshold, grow_target]`
   */
  #registryState: Uint32Array = new Uint32Array(
    new SharedArrayBuffer(5 * Uint32Array.BYTES_PER_ELEMENT),
  )

  #registryGuarantor?: Promise<number>

  #registryGuarantee?: (version: number) => void

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
  #guarantees: Sparse<(version: number) => void> = []

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
    this.#packed = new Float64Array(
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
    this.#registryState[STATE_OFFSET_LENGTH] = length
    this.#registryState[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#registryState[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor
  }

  #grow() {
    let length = this.#registryState[STATE_OFFSET_GROW_TARGET]
    this.#localVersion = this.#registryState[STATE_OFFSET_VERSION]++
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
    this.#entryLock = new Int32Array(
      new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT),
    )
    this.#registryState[STATE_OFFSET_LENGTH] = length
    this.#registryState[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#registryState[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor
  }

  async #check(v0 = this.#localVersion) {
    // Acquire a lock on the entire registry
    await acquireLock(this.#registryLock)
    // If the local version is behind
    if (this.#registryState[STATE_OFFSET_VERSION] > this.#localVersion) {
      let guarantor = this.#registryGuarantor ?? (
        this.#registryGuarantor = new Promise(resolve => this.#registryGuarantee = (v1) => this.#registryState[STATE_OFFSET_VERSION] === v1 ? resolve(v1): ()=>{})
      )
      
      // // Create a deferred promise which only resolves once 
      // let guarantor: Promise<number>
      // if (this.#registryGuarantor) {
      //   guarantor = this.#registryGuarantor
      // } else {
      //   guarantor = new Promise((resolve) => this.#registryGuarantee = resolve)
      // }
      // await guarantor.then(v1 => v1 < v0 ? this.#check(v0) : v0)
      // // wait for resized registry arrays
    }
    if (this.#registryState[STATE_OFFSET_SIZE] >= this.#registryState[STATE_OFFSET_GROW_THRESHOLD]) {
      this.#grow()
    }
    releaseLock(this.#registryLock)
  }

  /**
   * Find the offset of an existing key in the registry. Returns -1 if an
   * entry with the provided key does not exist.
   */
  #locate(key: number) {
    let length = this.#registryState[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    let end = offset + length
    while (offset < end) {
      let sparseIndex = offset % length
      if (this.#keys[sparseIndex] === key) return sparseIndex
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
    let length = this.#registryState[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    let end = offset + length
    // We use an infinite loop to eliminate some checks as a minor performance
    // optimization.
    while (offset < end) {
      let sparseIndex = offset % length
      await acquireLock(this.#entryLock, sparseIndex)
      if (this.#keys[sparseIndex] === key || this.#keys[sparseIndex] === 0) return this.#ensure(sparseIndex)
      releaseLock(this.#entryLock, sparseIndex)
      offset++
    }
    return -1
  }

  /**
   * Ensure this thread has the latest version of an entry. Returns a promise
   * that resolves only 
   */
  async #ensure(sparseIndex: number, v0 = this.#localEntryVersions[sparseIndex]): Promise<number> {
    if (v0 < this.#versions[sparseIndex]) {
      let guarantor = this.#guarantors[sparseIndex]
      if (guarantor === undefined) {
        guarantor = new Promise(resolve => (this.#guarantees[sparseIndex] = resolve))
        this.#guarantors[sparseIndex] = guarantor
      }
      return guarantor.then(v1 => (v1 < v0 ? this.#ensure(sparseIndex, v0) : sparseIndex)).then((result) => {
        this.#guarantors[sparseIndex] = undefined
        this.#guarantees[sparseIndex] = undefined
        return result
      })
    }
    return Promise.resolve(sparseIndex)
  }

  async acquire(key: number) {
    let sparseIndex = await this.#acquire(key)
    if (sparseIndex === -1) return undefined
    return this.#values[this.#sparse[sparseIndex]]
  }

  async release(key: number) {
    let sparseIndex = await this.#acquire(key)
    if (sparseIndex === -1) return false
    releaseLock(this.#entryLock, sparseIndex)
    return true
  }

  #set(key: number, sparseIndex: number, value: T, version?: number) {
    let packedIndex: number
    if (version === undefined || version === 0) {
      packedIndex = this.#registryState[STATE_OFFSET_SIZE]++
      this.#keys[sparseIndex] = key
      this.#packed[packedIndex] = sparseIndex
      this.#sparse[sparseIndex] = packedIndex
    } else {
      packedIndex = this.#sparse[sparseIndex]
    }
    this.#values[packedIndex] = value
    this.#localEntryVersions[sparseIndex] = ++this.#versions[sparseIndex]
  }

  async set(key: number, value: T) {
    let sparseIndex = await this.#acquire(key)
    Debug.assert(sparseIndex > -1)
    let version = this.#versions[sparseIndex]
    this.#set(key, sparseIndex, value, version)
    releaseLock(this.#entryLock, sparseIndex)
    Signal.dispatch(this.onShare, [key, value, this.#localEntryVersions[sparseIndex]])
    return this
  }

  async recieve(message: Message) {
    switch (message[0]) {
      case 0: {
        const [, key, value, version] = message
        let sparseIndex = await this.#acquire(key)
        Debug.assert(sparseIndex > -1)
        let localVersion = this.#localEntryVersions[sparseIndex]
        let guarantee = this.#guarantees[sparseIndex]
        if (localVersion === undefined) {
          this.#set(key, sparseIndex, value as T, localVersion)
        } else if (version > localVersion) {
          this.#values[this.#sparse[sparseIndex]] = value as T
        }
        guarantee?.(version)
        releaseLock(this.#entryLock, sparseIndex)
      }
      case 1: {

      }
    }

  }

  get size() {
    return this.#registryState[STATE_OFFSET_SIZE]
  }

  async has(key: number) {
    return this.#locate(key) > 0
  }

  async delete(key: number) {
    if (!this.has(key)) return false
    let sparseIndex = await this.#acquire(key)
    let packedIndex = this.#sparse[sparseIndex]
    this.#sparse[sparseIndex] = 0
    this.#packed[packedIndex] = 0
    this.#keys[sparseIndex] = 0
    this.#localEntryVersions[sparseIndex] = this.#versions[sparseIndex] = 0
    // @ts-expect-error
    this.#values[sparseIndex] = undefined
    this.#registryState[STATE_OFFSET_SIZE]--
    releaseLock(this.#entryLock, sparseIndex)
    return true
  }

  async clear() {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    let promises: Promise<unknown>[] = []
    for (let denseIndex = 0; denseIndex < size; denseIndex++) {
      promises.push(this.delete(this.#sparse[this.#packed[denseIndex]]))
    }
    await Promise.all(promises)
  }

  forEach(iteratee: ForEachCallback<T>, thisArg?: any) {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let denseIndex = 0; denseIndex < size; denseIndex++) {
      iteratee.call(thisArg, this.#values[denseIndex]!, this.#sparse[this.#packed[denseIndex]], this)
    }
  }

  *entries(): IterableIterator<[number, T]> {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let denseIndex = 0; denseIndex < size; denseIndex++) {
      yield [this.#sparse[this.#packed[denseIndex]], this.#values[denseIndex]!]
    }
  }

  *keys(): IterableIterator<number> {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let denseIndex = 0; denseIndex < size; denseIndex++) {
      yield this.#sparse[this.#packed[denseIndex]]
    }
  }

  *values(): IterableIterator<T> {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let denseIndex = 0; denseIndex < size; denseIndex++) {
      yield this.#values[denseIndex]
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  get [Symbol.toStringTag]() {
    return "Registry"
  }
}
