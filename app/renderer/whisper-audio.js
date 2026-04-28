/** Decode browser-supported audio to mono float32 + native sample rate for main-process Whisper. */
(function (global) {
  /**
   * @param {AudioBuffer} buf
   * @returns {Float32Array}
   */
  function mixToMono(buf) {
    const n = buf.numberOfChannels;
    const len = buf.length;
    const out = new Float32Array(len);
    if (n <= 1) {
      out.set(buf.getChannelData(0));
      return out;
    }
    for (let c = 0; c < n; c += 1) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i += 1) {
        out[i] += ch[i] / n;
      }
    }
    return out;
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<{ samples: Float32Array, sampleRate: number }>}
   */
  async function decodeToMonoF32(arrayBuffer) {
    const ctx = new AudioContext();
    try {
      const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const samples = mixToMono(buf);
      const sampleRate = buf.sampleRate;
      return { samples, sampleRate };
    } finally {
      await ctx.close();
    }
  }

  global.aaWhisperDecode = { decodeToMonoF32 };
})(window);
