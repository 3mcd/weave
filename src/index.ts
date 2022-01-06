import "./polyfill"
import * as Debug from "./debug"
import { Guarantor } from "./guarantor"
import * as Lock from "./lock"
import * as Signal from "./signal"

type ForEachCallback<T> = (value: T, key: number, registry: Registry<T>) => void

enum MessageType {
  ShareEntry,
  ShareState,
}

type State = {
  state: Uint32Array
  version: number
  sparse: Float64Array
  packed: Float64Array
  keys: Float64Array
  versions: Uint32Array
  locks: Int32Array
}

type ShareEntryMessage<T> = [
  type: MessageType.ShareEntry,
  key: number,
  value: T,
  version: number,
]

type ShareStateMessage = [type: MessageType.ShareState, state: State]

type Message<T> = ShareEntryMessage<T> | ShareStateMessage

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

class SharedGuarantor extends Guarantor<number> {
  #shared: Uint32Array
  #index: number

  constructor(shared: Uint32Array, index: number) {
    super(0)
    this.#shared = shared
    this.#index = index
  }

  filter(version: number) {
    return version === this.#shared[this.#index]
  }

  isInvalid() {
    return this.latest < this.#shared[this.#index]
  }

  increment() {
    const version = ++this.#shared[this.#index]
    this.load(version)
    return version
  }
}

function makeRegistrySharedArrays(length: number) {
  let lengthF64 = length * Float64Array.BYTES_PER_ELEMENT
  let lengthU32 = length * Uint32Array.BYTES_PER_ELEMENT
  let lengthI32 = length * Int32Array.BYTES_PER_ELEMENT
  return {
    sparse: new Float64Array(new SharedArrayBuffer(lengthF64)),
    packed: new Float64Array(new SharedArrayBuffer(lengthF64)),
    keys: new Float64Array(new SharedArrayBuffer(lengthF64)),
    versions: new Uint32Array(new SharedArrayBuffer(lengthU32)),
    locks: new Int32Array(new SharedArrayBuffer(lengthI32)),
  }
}

export function makeShareEntryMessage<T>(
  key: number,
  value: T,
  version: number,
): ShareEntryMessage<T> {
  return [MessageType.ShareEntry, key, value, version]
}

export function makeShareStateMessage(state: State): ShareStateMessage {
  return [MessageType.ShareState, state]
}

export class Registry<T> {
  #registryLock: Int32Array = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  )

  /**
   * `[version, size, length, grow_threshold, grow_target]`
   */
  #registryState: Uint32Array = new Uint32Array(
    new SharedArrayBuffer(5 * Uint32Array.BYTES_PER_ELEMENT),
  )

  #registryVersionGuarantor = new SharedGuarantor(
    this.#registryState,
    STATE_OFFSET_VERSION,
  )

  /**
   * Sparse TypedArray of keys.
   */
  #keys: Float64Array

  /**
   * Sparse TypedArray of entry lock bits.
   */
  #locks: Int32Array

  /**
   * Dense TypedArray that maps values to their offset in the sparse arrays.
   */
  #packed: Float64Array

  /**
   * Sparse TypedArray that maps keys to their offset in the packed arrays.
   */
  #sparse: Float64Array

  /**
   * Sparse TypedArray of entry versions.
   */
  #versions: Uint32Array

  /**
   * Dense array of local map values.
   */
  #values: T[] = []

  /**
   * A sparse array of deferred promises to be resolved when their guarantee
   * is executed (upon recieving the latest entry version from another thread).
   */
  #entryVersionGuarantors: SharedGuarantor[] = []

  #loadFactor: number = 0.7
  #growFactor: number = 2

  onShareState = Signal.make<ShareStateMessage>()
  onShareEntry = Signal.make<ShareEntryMessage<T>>()

  constructor(length = 1000, loadFactor?: number, growFactor?: number) {
    const { sparse, packed, keys, versions, locks } = makeRegistrySharedArrays(length)
    this.#loadFactor = loadFactor ?? this.#loadFactor
    this.#growFactor = growFactor ?? this.#growFactor
    this.#keys = keys
    this.#locks = locks
    this.#packed = packed
    this.#sparse = sparse
    this.#versions = versions
    this.#registryState[STATE_OFFSET_LENGTH] = length
    this.#registryState[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#registryState[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor
  }

  async #grow() {
    const prevKeys = this.#keys
    const prevLocks = this.#locks
    const prevPacked = this.#packed
    const prevValues = this.#values
    const { [STATE_OFFSET_SIZE]: size, [STATE_OFFSET_GROW_TARGET]: length } =
      this.#registryState
    const { sparse, packed, keys, versions, locks } = makeRegistrySharedArrays(length)

    this.#registryVersionGuarantor.increment()

    this.#keys = keys
    this.#locks = locks
    this.#packed = packed
    this.#sparse = sparse
    this.#versions = versions
    this.#registryState[STATE_OFFSET_LENGTH] = length
    this.#registryState[STATE_OFFSET_GROW_THRESHOLD] = length * this.#loadFactor
    this.#registryState[STATE_OFFSET_GROW_TARGET] = length + length * this.#growFactor

    for (let packedIndex = 0; packedIndex < size; packedIndex++) {
      let sparseIndex = prevPacked[packedIndex]
      await this.#acquireEntryLock(sparseIndex)
      await this.#set(prevKeys[sparseIndex], sparseIndex, prevValues[packedIndex])
      Lock.releaseLock(prevLocks, sparseIndex)
    }

    Signal.dispatch(this.onShareState, makeShareStateMessage(this.state))
  }

  async #ensureRegistry() {
    await Lock.acquireLock(this.#registryLock)
    await this.#registryVersionGuarantor.guarantee()
    if (
      this.#registryState[STATE_OFFSET_SIZE] >=
      this.#registryState[STATE_OFFSET_GROW_THRESHOLD]
    ) {
      await this.#grow()
    }
    Lock.releaseLock(this.#registryLock)
  }

  /**
   * Find the offset of an existing key in the registry. Returns -1 if an
   * entry with the provided key does not exist.
   */
  #locateExistingEntry(key: number) {
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
  async #locateAndAcquireEntry(key: number) {
    let length = this.#registryState[STATE_OFFSET_LENGTH]
    let offset = slot(key, length)
    let end = offset + length
    while (offset < end) {
      let sparseIndex = offset % length
      await this.#acquireEntryLock(sparseIndex)
      if (this.#keys[sparseIndex] === key || this.#keys[sparseIndex] === 0) {
        return this.#ensureLatestEntryVersion(sparseIndex)
      }
      this.#releaseEntryLock(sparseIndex)
      offset++
    }
    return -1
  }

  /**
   * Return a promise that resolves only once the current thread has the latest
   * version of an entry.
   */
  async #ensureLatestEntryVersion(sparseIndex: number): Promise<number> {
    const guarantor = this.#getOrMakeEntryVersionGuarantor(sparseIndex)
    await guarantor.guarantee()
    return sparseIndex
  }

  #getOrMakeEntryVersionGuarantor(sparseIndex: number) {
    return (
      this.#entryVersionGuarantors[sparseIndex] ??
      (this.#entryVersionGuarantors[sparseIndex] = new SharedGuarantor(
        this.#versions,
        sparseIndex,
      ))
    )
  }

  async #set(key: number, sparseIndex: number, value: T, version?: number) {
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
  }

  #acquiredEntries: number[] = []
  async #acquireEntryLock(sparseIndex: number) {
    if (this.#acquiredEntries[sparseIndex] > 0) {
      this.#acquiredEntries[sparseIndex]++
      return
    }
    await Lock.acquireLock(this.#locks, sparseIndex)
    this.#acquiredEntries[sparseIndex] = 1
  }

  #releaseEntryLock(sparseIndex: number, n = 1) {
    if ((this.#acquiredEntries[sparseIndex] -= n) <= 0) {
      Lock.releaseLock(this.#locks, sparseIndex)
      this.#acquiredEntries[sparseIndex] = 0
    }
  }

  async acquire(key: number) {
    let sparseIndex = await this.#locateAndAcquireEntry(key)
    if (sparseIndex === -1) return undefined
    return this.#values[this.#sparse[sparseIndex]]
  }

  async release(key: number) {
    let sparseIndex = await this.#locateAndAcquireEntry(key)
    if (sparseIndex === -1) return false
    this.#releaseEntryLock(sparseIndex, 2)
    return true
  }

  async get(key: number) {
    await this.#ensureRegistry()
    const sparseIndex = await this.#locateAndAcquireEntry(key)
    if (sparseIndex === -1) return undefined
    const value = this.#values[this.#sparse[sparseIndex]]
    this.#releaseEntryLock(sparseIndex)
    return value
  }

  async set(key: number, value: T) {
    await this.#ensureRegistry()
    const sparseIndex = await this.#locateAndAcquireEntry(key)
    const guarantor = this.#getOrMakeEntryVersionGuarantor(sparseIndex)
    const version = this.#versions[sparseIndex]
    Debug.assert(sparseIndex > -1)
    await this.#set(key, sparseIndex, value, version)
    this.#releaseEntryLock(sparseIndex)

    Signal.dispatch(
      this.onShareEntry,
      makeShareEntryMessage(key, value, guarantor.increment()),
    )
    return this
  }

  async receiveMessage(message: Message<T>) {
    switch (message[0]) {
      case MessageType.ShareEntry: {
        const [, key, value, version] = message
        const sparseIndex = this.#locateExistingEntry(key)
        await this.#acquireEntryLock(sparseIndex)
        const guarantor = this.#getOrMakeEntryVersionGuarantor(sparseIndex)
        this.#values[this.#sparse[sparseIndex]] = value
        guarantor.load(version)
        this.#releaseEntryLock(sparseIndex)
        break
      }
      case MessageType.ShareState: {
        const [, { sparse, packed, keys, versions, locks, version, state }] = message
        this.#registryState = state
        this.#sparse = sparse
        this.#packed = packed
        this.#keys = keys
        this.#versions = versions
        this.#locks = locks
        this.#registryVersionGuarantor.load(version)
      }
    }
  }

  get size() {
    return this.#registryState[STATE_OFFSET_SIZE]
  }

  async has(key: number) {
    return this.#locateExistingEntry(key) > 0
  }

  async delete(key: number) {
    if (!this.has(key)) return false
    const sparseIndex = await this.#locateAndAcquireEntry(key)
    const packedIndex = this.#sparse[sparseIndex]
    const guarantor = this.#getOrMakeEntryVersionGuarantor(sparseIndex)
    guarantor.load(0)
    this.#sparse[sparseIndex] = this.#packed[packedIndex] = this.#keys[sparseIndex] = 0
    // @ts-expect-error
    this.#values[sparseIndex] = undefined
    this.#registryState[STATE_OFFSET_SIZE]--
    this.#releaseEntryLock(sparseIndex)
    return true
  }

  async clear() {
    await this.#ensureRegistry()
    let size = this.#registryState[STATE_OFFSET_SIZE]
    let ops: Promise<unknown>[] = []
    for (let packedIndex = 0; packedIndex < size; packedIndex++) {
      ops.push(this.delete(this.#sparse[this.#packed[packedIndex]]))
    }
    await Promise.all(ops)
  }

  forEach(iteratee: ForEachCallback<T>, thisArg?: any) {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let packedIndex = 0; packedIndex < size; packedIndex++) {
      iteratee.call(
        thisArg,
        this.#values[packedIndex]!,
        this.#sparse[this.#packed[packedIndex]],
        this,
      )
    }
  }

  *entries(): IterableIterator<[number, T]> {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let packedIndex = 0; packedIndex < size; packedIndex++) {
      yield [this.#sparse[this.#packed[packedIndex]], this.#values[packedIndex]!]
    }
  }

  *keys(): IterableIterator<number> {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let packedIndex = 0; packedIndex < size; packedIndex++) {
      yield this.#sparse[this.#packed[packedIndex]]
    }
  }

  *values(): IterableIterator<T> {
    let size = this.#registryState[STATE_OFFSET_SIZE]
    for (let packedIndex = 0; packedIndex < size; packedIndex++) {
      yield this.#values[packedIndex]
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  get [Symbol.toStringTag]() {
    return "Registry"
  }

  get state(): State {
    return {
      keys: this.#keys,
      locks: this.#locks,
      packed: this.#packed,
      sparse: this.#sparse,
      state: this.#registryState,
      version: this.#registryVersionGuarantor.latest ?? 0,
      versions: this.#versions,
    }
  }
}
