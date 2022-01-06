export type Subscriber<T> = (t: T) => void
export type Struct<T = void> = Subscriber<T>[]

export class Signal<T = void> {
  #subscribers: Subscriber<T>[] = []
  subscribe(subscriber: Subscriber<T>) {
    const index = this.#subscribers.push(subscriber) - 1
    return () => {
      this.#subscribers.splice(index, 1)
    }
  }
  dispatch(t: T) {
    for (let i = this.#subscribers.length - 1; i >= 0; i--) {
      this.#subscribers[i](t)
    }
  }
}
