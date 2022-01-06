# weave

⚠️ WIP, don't use it yet!

Weave (name tbd) is a thread-safe map for complex, cloneable/transferable objects that are shared between multiple threads.

It's intended to be used to share `SharedArrayBuffer` instances between multiple worker threads. Since ArrayBuffers are fixed-length (meaning they can neither grow nor shrink once initialized), worker threads must be notified when their memory grows stale and a new ArrayBuffer is on the way. This library provides `Registry`, a type of map which can:

- instantly notify threads of new entries
- lock read/write operations of an entry to a single thread
- transfer new versions of objects (like `SharedArrayBuffer`, or any value that works with [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone) ) to other threads

Hopefully **this strategy will be invalidated** by https://github.com/tc39/proposal-resizablearraybuffer, which should provide the means to resize SharedArrayBuffer instances in-place.

### Basics

The package exports a map called `Registry`:

```ts
import { Registry } from "weave"
const map = new Registry()
```

A registry has similar semantics to native JS maps. However, a registry can only use **positive integer** keys, and many methods insetad return Promises:

```ts
await map.set(1, "suh")
await map.get(1) // "suh"
```

`Registry` also implements common iterator methods:

```ts
map.keys()
map.values()
map.entries()
for (const [key, value] of map) {
}
```

The map is intended to be shared between multiple threads. In node, initial map state can be shared via the `Worker` constructor's `workerData` option.

```ts
// index.ts
import { Worker } from "worker_threads"
import { Registry } from "weave"
const map = new Registry()
const worker = new Worker("./worker.js", { workerData: map.init() })
```

You'll also need to hook up signalling between the maps:

```ts
// index.ts
map.onMessage.subscribe(m => worker.postMessage(m))
worker.on("message", m => map.receiveMessage(m))
```

In the worker, create a `Registry` and pass the initial map state to the constructor:

```ts
// worker.ts
import { Worker, workerData, parentPort } from "worker_threads"
import { Registry } from "weave"
const map = new Registry(workerData)
map.onMessage.subscribe(m => parentPort.postMessage(m))
parentPort.on("message", m => map.receiveMessage(m))
```

And voilà, you have a map that will synchronize entries between threads, while ensuring that only one thread can modify an entry at a time.

### Example

Below is a pseudo-code example of sharing a "resizable" array buffer between the main thread and a worker thread.

```ts
// index.ts
await map.set(1, new Uint8Array(new SharedArrayBuffer(10)))
setTimeout(async () => {
  const arr = await map.get(1)
  arr.byteLength // 20, the doubled array
}, 1000)
```

```ts
// worker.ts
const arr = await map.acquire(1)
const arrDoubled = doubleTypedArray(arr)
await map.set(1, arrDoubled)
```
