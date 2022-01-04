import { Registry } from "./index"

describe("Registry", () => {
  it("works", async () => {
    try {
      let r = new Registry(10, () => {})
      await r.set(1, {})
      console.log("A")
      await r.get(1)
      console.log("B")
    } catch (error) {
      console.log(error)
    }
  })
})
