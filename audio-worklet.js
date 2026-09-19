class LiveLingoCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input?.length) return true;

    let readOffset = 0;
    while (readOffset < input.length) {
      const writable = Math.min(this.bufferSize - this.offset, input.length - readOffset);
      this.buffer.set(input.subarray(readOffset, readOffset + writable), this.offset);
      this.offset += writable;
      readOffset += writable;

      if (this.offset === this.bufferSize) {
        const chunk = this.buffer;
        this.port.postMessage(chunk, [chunk.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('livelingo-capture', LiveLingoCaptureProcessor);
