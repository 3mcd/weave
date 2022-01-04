# weave

weave is a resolver for complex serializable structures shared between multiple threads

```ts
// worker.js
let r = new Registry(10, (m) => globalThis.postMessage(m))
globalThis.addEventListener("message", () => r.recieve(e.data))

await r.set(1, { name: "pearce" })

// index.js
let r = new Registry(10, (m) => worker.postMessage(m))
let w = new Worker("worker.js")
w.addEventListener("message", (e) => r.recieve(e.data))

await r.set(1, { name: "fieri" })

// after some time
await r1.get(1) // { name: "pearce" }
```

* familiar api — similar to Map (but async)
* threads are instantly notified of new map entries
* objects are reserved for one thread at a time
* threads will eventually resolve the latest versions of values