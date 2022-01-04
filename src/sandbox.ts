import { Registry } from "./index"

try {
  let r = new Registry(10, () => {})
  await r.set(1, { hi: "mom" })
  await r.set(2, { hi: "dad" })
  await r.set(3, { hi: "bro" })
  console.log(await r.acquire(3))
  console.log(Array.from(r))
} catch (error) {
  console.log(error)
}
