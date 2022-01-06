import { Worker, isMainThread, parentPort, workerData } from "worker_threads"
import { Registry } from "./src"

let key = 1

if (isMainThread) {
  const registry = new Registry(10)
  const worker = new Worker("./sandbox.js", {
    workerData: registry.init(),
  })
  registry.onMessage.subscribe(m => worker.postMessage(m))
  worker.on("message", m => registry.receiveMessage(m))
  for (let i = 0; i < 1_000; i++) {
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
  registry.onMessage.subscribe(m => parentPort.postMessage(m))
  parentPort.on("message", m => registry.receiveMessage(m))
  for (let i = 0; i < 1_000; i++) {
    await registry.set(key, ((await registry.get(key)) ?? 0) + 1)
  }
}
