type Maybe<T> = T | null

export class Guarantor<T> {
  #resolve: Maybe<(t: T) => T | null> = null
  #promise: Maybe<Promise<T>> = null
  #latest: T

  constructor(init: T) {
    this.#latest = init
  }

  #make() {
    if (this.#promise === null) {
      this.#promise = new Promise<T>(resolve => {
        this.#resolve = (t: T) => {
          if (this.filter(t)) {
            resolve(t)
            return t
          } else {
            return null
          }
        }
      })
        .then((t: T) => {
          this.#latest = t
          return t
        })
        .finally(() => {
          this.#promise = null
          this.#resolve = null
        })
    }
    return this.#promise
  }

  filter(t: T) {
    return true
  }

  isInvalid() {
    return true
  }

  load(t: T) {
    if (this.#resolve) {
      this.#resolve(t)
    } else {
      this.#latest = t
    }
  }

  guarantee() {
    return this.isInvalid() ? this.#make() : Promise.resolve(this.#latest)
  }

  get latest() {
    return this.#latest
  }
}
