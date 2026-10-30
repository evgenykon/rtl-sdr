// Spectral-subtraction denoiser for 48 kHz mono audio.
// Loaded as an AudioWorklet; expects messages { amount: 0..1 }.

const N = 512;
const HOP = 128;
const HALF = N / 2;
const OLA_SCALE = 1 / 1.5; // Hann analysis * Hann synthesis, hop N/4

const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

const rev = new Uint16Array(N);
const bits = Math.round(Math.log2(N));
for (let i = 0; i < N; i++) {
  let x = i;
  let r = 0;
  for (let j = 0; j < bits; j++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  rev[i] = r;
}

const cosT = new Float32Array(HALF);
const sinT = new Float32Array(HALF);
for (let i = 0; i < HALF; i++) {
  cosT[i] = Math.cos((-2 * Math.PI * i) / N);
  sinT[i] = Math.sin((-2 * Math.PI * i) / N);
}

function fft(re, im) {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const c = cosT[k];
        const s = sinT[k];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function ifft(re, im) {
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < N; i++) {
    re[i] /= N;
    im[i] = -im[i] / N;
  }
}

class DenoiserProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.amount = 0;
    this.frames = 0;
    this.noise = new Float32Array(HALF + 1);
    this.prevGain = new Float32Array(HALF + 1).fill(1);
    this.gain = new Float32Array(HALF + 1);
    this.gainTmp = new Float32Array(HALF + 1);
    this.inBuf = new Float32Array(N);
    this.ola = new Float32Array(N);
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.port.onmessage = (e) => {
      const a = e.data && e.data.amount;
      if (typeof a === "number") this.amount = Math.max(0, Math.min(1, a));
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    this.inBuf.copyWithin(0, HOP);
    if (input) this.inBuf.set(input.subarray(0, HOP), N - HOP);
    else this.inBuf.fill(0, N - HOP);

    for (let i = 0; i < N; i++) {
      this.re[i] = this.inBuf[i] * hann[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);

    const amt = this.amount;
    this.frames++;
    const active = amt > 0 && this.frames > 20;
    const sub = amt * 2;

    for (let k = 0; k <= HALF; k++) {
      const mag = Math.hypot(this.re[k], this.im[k]) + 1e-9;
      let n = this.noise[k];
      if (n === 0) n = mag;
      if (mag < n) n += 0.25 * (mag - n);
      else n += 0.002 * (mag - n);
      this.noise[k] = n;

      let g = 1;
      if (active) {
        g = 1 - (sub * n) / mag;
        if (g < 0.03) g = 0.03;
        else if (g > 1) g = 1;
      }
      g = this.prevGain[k] * 0.6 + g * 0.4;
      this.prevGain[k] = g;
      this.gain[k] = g;
    }

    // slight frequency smoothing to reduce "musical noise"
    this.gainTmp.set(this.gain);
    for (let k = 1; k < HALF; k++) {
      this.gain[k] = this.gainTmp[k] * 0.5 + (this.gainTmp[k - 1] + this.gainTmp[k + 1]) * 0.25;
    }

    for (let k = 0; k <= HALF; k++) {
      const g = this.gain[k];
      this.re[k] *= g;
      this.im[k] *= g;
      if (k > 0 && k < HALF) {
        this.re[N - k] *= g;
        this.im[N - k] *= g;
      }
    }

    ifft(this.re, this.im);

    for (let i = 0; i < N; i++) this.ola[i] += this.re[i] * hann[i] * OLA_SCALE;
    for (let i = 0; i < HOP; i++) output[i] = this.ola[i];
    this.ola.copyWithin(0, HOP);
    this.ola.fill(0, N - HOP);
    return true;
  }
}

registerProcessor("denoiser", DenoiserProcessor);
