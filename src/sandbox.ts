import { Registry } from "./index"

try {
  let r1 = new Registry(10, (k, v, vv) => r2.recieve(k, vv, v))
  let r2 = new Registry(10, () => {})
  await r1.set(1, { hi: "mom" })
  await r1.set(2, { hi: "dad" })
  await r1.set(3, { hi: "bro" })
  await r1.set(3, { hi: "han" })
  console.log(await r1.acquire(3))
  console.log(Array.from(r1))
  console.log(r1 + "")
} catch (error) {
  console.log(error)
}
