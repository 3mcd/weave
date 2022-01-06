# weave

⚠️ WIP, don't use it yet!

Weave is a thread-safe map for complex, transferable objects that are shared between multiple threads.

It's intended to be used to share `SharedArrayBuffer` instances between multiple worker threads. Since ArrayBuffers are fixed-length (meaning they can neither grow nor shrink once initialized), worker threads must be notified when their memory grows stale and a new ArrayBuffer is on the way. This library provides `Registry`, a type of map which can:
- instantly notify threads of new entries
- lock read/write operations of an entry to a single thread
- transfer new copies of objects (like `SharedArrayBuffers`, but any `postMessage`-transferable object will work) to other threads

### Example

```ts
// main.js
import { Registry } from "weave"
import { bind } from "weave/node"
import { Worker } from "worker_threads"
// Make a map with an initial size of 1,000
const registry = new Registry(1_000)
// Create and bind worker events
const worker = new Worker("./worker.js", { workerData: registry.state })
bind(registry, worker)

await map.set(1, { foo: "bar", array: new Uint8Array(new SharedArrayBuffer(4)) })

// worker.js
import { Registry } from "weave"
import { workerData } from "worker_threads"
const registry = new Registry(workerData)

await map.get(1) // { foo: "bar", ... }
```
