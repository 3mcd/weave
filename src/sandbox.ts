import { Registry } from "./index"
import * as Signal from "./signal"

try {
  let registry = new Registry(2)
  await registry.set(1, { hi: "mom" })
  await registry.set(2, { hi: "dad" })
  await registry.set(3, { hi: "bro" })
  await registry.set(3, { hi: "han" })
  console.log(await registry.acquire(3))
} catch (error) {
  console.log(error)
}
