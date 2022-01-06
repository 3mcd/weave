import { Guarantor } from "./guarantor"

class Positive extends Guarantor<number> {
  filter(n: number) {
    return n > 0
  }

  isInvalid() {
    return this.latest <= 0
  }
}

describe("Guarantor", () => {
  beforeAll(() => jest.useFakeTimers())
  afterAll(() => jest.useRealTimers())
  it("works", () => {
    const positive = new Positive(0)
    jest.useFakeTimers()
    setTimeout(() => positive.update(-10), 0)
    jest.runAllTimers()
    setTimeout(() => positive.update(0.1), 1)
    jest.runAllTimers()
    return expect(positive.guarantee()).resolves.toBe(0.1)
  })
  it("works", async () => {
    const positive = new Positive(0)
    jest.useFakeTimers()
    setTimeout(() => positive.update(-10), 0)
    jest.runAllTimers()
    setTimeout(() => positive.update(0.1), 1)
    jest.runAllTimers()
    await expect(positive.guarantee()).resolves.toBe(0.1)
    setTimeout(() => positive.update(-1000), 1)
    jest.runAllTimers()
    setTimeout(() => positive.update(10), 1)
    jest.runAllTimers()
    await expect(positive.guarantee()).resolves.toBe(10)
    await expect(positive.guarantee()).resolves.toBe(10)
  })
})
