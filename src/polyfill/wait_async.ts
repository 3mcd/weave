;(function () {
  let helperCode = `
  onmessage = function (ev) {
    try {
        switch (ev.data[0]) {
        case 'wait': {
      let [_, ia, index, value, timeout] = ev.data;
      let result = Atomics.wait(ia, index, value, timeout)
      postMessage(['ok', result]);
      break;
        }
        default:
      throw new Error("Bogus message sent to wait helper: " + e);
        }
    } catch (e) {
        console.log("Exception in wait helper");
        postMessage(['error', 'Exception']);
    }
  }
  `

  let helpers: any[] = []

  function allocHelper() {
    if (helpers.length > 0) return helpers.pop()
    let h = new Worker("data:application/javascript," + encodeURIComponent(helperCode))
    return h
  }

  function freeHelper(h: any) {
    helpers.push(h)
  }

  // @ts-expect-error
  if (typeof Atomics.waitAsync === "function") return

  // @ts-expect-error
  Atomics.waitAsync = function (
    ia: Int32Array,
    index_: number,
    value_: number,
    timeout_: number,
  ) {
    if (
      typeof ia != "object" ||
      !(ia instanceof Int32Array) ||
      !(ia.buffer instanceof SharedArrayBuffer)
    )
      throw new TypeError("Expected shared memory")

    // These conversions only approximate the desired semantics but are
    // close enough for the polyfill.

    let index = index_ | 0
    let value = value_ | 0
    let timeout = timeout_ === undefined ? Infinity : +timeout_

    // Range checking for the index.

    ia[index]

    // Optimization, avoid the helper thread in this common case.

    if (Atomics.load(ia, index) != value) return Promise.resolve("not-equal")

    // General case, we must wait.

    return new Promise(function (resolve, reject) {
      let h = allocHelper()
      h.onmessage = function (ev: any) {
        freeHelper(h)
        switch (ev.data[0]) {
          case "ok":
            resolve(ev.data[1])
            break
          case "error":
            reject(ev.data[1])
            break
        }
      }

      h.postMessage(["wait", ia, index, value, timeout])
    })
  }
})()
