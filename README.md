# weave

⚠️ WIP, don't use it yet!

Weave (name tbd) is a thread-safe map for complex, cloneable/transferable objects that are shared between multiple threads.

It's intended to be used to share `SharedArrayBuffer` instances between multiple worker threads. Since ArrayBuffers are fixed-length (meaning they can neither grow nor shrink once initialized), worker threads must be notified when their memory grows stale and a new ArrayBuffer is on the way. This library provides `Registry`, a type of map which can:
- instantly notify threads of new entries
- lock read/write operations of an entry to a single thread
- transfer new versions of objects (like `SharedArrayBuffer`, or any value that works with [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone) ) to other threads

Eventually **this strategy will be invalidated** by https://github.com/tc39/proposal-resizablearraybuffer, which should provide the means to resize SharedArrayBuffer instances in-place.

### Basics

The package exports a map called `Registry`:

```ts
import { Registry } from "weave"
const map = new Registry()
```

A registry has a similar API to native JS maps. However, a registry can only use **positive integer** keys, and many methods insetad return Promises:

```ts
await map.set(1, "suh")
await map.get(1) // "suh"
```

`Registry` also implements common iterator methods like `keys`, `values`, etc.

```ts
map.keys()
map.values()
map.entries()
for (const [key, value] of map) {}
// ..and so on
```

The map is intended to be shared between multiple threads. The initial map state is sent up via `workerData` option. Signalling is hooked up via the `bind` function.
```ts
import { bind } from "weave/node"
import { Worker } from "worker_threads"
// ...
const worker = new Worker("./worker.js", { workerData: registry.data })
bind(registry, worker)
```

In the worker, create a `Registry` and pass the initial map state to the constructor:

```ts
import { workerData } from "worker_threads"
const registry = new Registry(workerData)
bind(registry)
```

And voilà, you have a map that will automatically synchronize entries between threads, while ensuring that only one thread can modify an entry at a time.

### Example

```ts
// main.js
import { Registry } from "weave"
import { bind } from "weave/node"
import { Worker } from "worker_threads"
// Make a map with an initial size of 1,000
const registry = new Registry(1_000)
// Create and bind worker events
const worker = new Worker("./worker.js", { workerData: registry.data })
bind(registry, worker)

await map.set(1, { foo: "bar", array: new Uint8Array(new SharedArrayBuffer(4)) })

// worker.js
import { Registry } from "weave"
import { workerData } from "worker_threads"
const registry = new Registry(workerData)

await map.get(1) // { foo: "bar", ... }
```
