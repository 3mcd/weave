class Worker {
  constructor(stringUrl) {
    this.url = stringUrl
    this.onmessage = () => {}
  }

  postMessage(message) {
    this.onmessage({ data: message })
  }
}

global.Worker = Worker
