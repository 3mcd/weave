import { Worker, isMainThread, parentPort, workerData } from "worker_threads"
import { Registry, makeShareStateMessage } from "./index"
import * as Signal from "./signal"

let key = 1

if (isMainThread) {
  const registry = new Registry(10)
  const worker = new Worker("./src/sandbox_worker.js", {
    workerData: makeShareStateMessage(registry.state),
  })
  Signal.subscribe(registry.onShareEntry, m => worker.postMessage(m))
  Signal.subscribe(registry.onShareState, m => worker.postMessage(m))
  worker.on("message", m => registry.receiveMessage(m))
  for (let i = 0; i < 1000; i++) {
    await registry.set(key, ((await registry.get(key)) ?? 0) + 1)
  }
  let prev
  let interval = setInterval(async () => {
    const value = await registry.get(key)
    if (prev !== value) {
      console.log(value)
      prev = value
    }
    if (value === 2_000) {
      clearInterval(interval)
      console.log("Done!")
    }
  }, 1)
} else {
  const registry = new Registry(10)
  await registry.receiveMessage(workerData)
  Signal.subscribe(registry.onShareEntry, m => parentPort?.postMessage(m))
  Signal.subscribe(registry.onShareState, m => parentPort?.postMessage(m))
  parentPort?.on("message", m => registry.receiveMessage(m))
  for (let i = 0; i < 1000; i++) {
    await registry.set(key, ((await registry.get(key)) ?? 0) + 1)
  }
}
