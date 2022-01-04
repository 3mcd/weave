import { Registry } from "./index"
import * as Signal from "./signal"

try {
  let r1 = new Registry(10)
  let r2 = new Registry(10)
  Signal.subscribe(r1.onShare, ([key, value, version]) => r2.recieve(key, value, version))
  await r1.set(1, { hi: "mom" })
  await r1.set(2, { hi: "dad" })
  await r1.set(3, { hi: "bro" })
  await r1.set(3, { hi: "han" })
  // console.log(Array.from(r1))
  // setTimeout(() => console.log(Array.from(r2)), 0)
  await r1.clear()
  console.log(await r1.acquire(2))
} catch (error) {
  console.log(error)
}
