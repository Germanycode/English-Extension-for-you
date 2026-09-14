// AudioWorklet processor for streaming microphone audio in Gemini Live coach
class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.bytesWritten = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channelData = input[0];

    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bytesWritten++] = channelData[i];
      if (this.bytesWritten >= this.bufferSize) {
        this.port.postMessage({
          audioData: this.buffer.slice()
        });
        this.bytesWritten = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
