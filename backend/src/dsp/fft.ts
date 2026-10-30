const twiddleCache = new Map<number, { cos: Float32Array; sin: Float32Array }>();

function getTwiddles(n: number): { cos: Float32Array; sin: Float32Array } {
  let cached = twiddleCache.get(n);
  if (!cached) {
    const cos = new Float32Array(n / 2);
    const sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      const angle = (-2 * Math.PI * i) / n;
      cos[i] = Math.cos(angle);
      sin[i] = Math.sin(angle);
    }
    cached = { cos, sin };
    twiddleCache.set(n, cached);
  }
  return cached;
}

function bitReverse(re: Float32Array, im: Float32Array, n: number): void {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
}

export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two");
  bitReverse(re, im, n);
  const { cos, sin } = getTwiddles(n);

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const idx = j * step;
        const wr = cos[idx];
        const wi = sin[idx];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

export function spectrumDb(re: Float32Array, im: Float32Array, out: Float32Array): void {
  const n = re.length;
  const half = n >> 1;
  for (let i = 0; i < n; i++) {
    const src = (i + half) % n;
    const mag = Math.sqrt(re[src] * re[src] + im[src] * im[src]) / n;
    out[i] = 20 * Math.log10(mag + 1e-9);
  }
}
