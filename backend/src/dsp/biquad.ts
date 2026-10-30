export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  lowpass(sampleRate: number, cutoff: number, q = 0.707): this {
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cosw) / 2 / a0;
    this.b1 = (1 - cosw) / a0;
    this.b2 = (1 - cosw) / 2 / a0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  highpass(sampleRate: number, cutoff: number, q = 0.707): this {
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cosw) / 2 / a0;
    this.b1 = (-(1 + cosw)) / a0;
    this.b2 = (1 + cosw) / 2 / a0;
    this.a1 = (-2 * cosw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(input: Float32Array, output?: Float32Array): Float32Array {
    const out = output ?? new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      out[i] = y;
    }
    return out;
  }

  reset(): this {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    return this;
  }
}
