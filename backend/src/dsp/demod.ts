import { Biquad } from "./biquad.js";

export type DemodMode = "fm" | "nfm" | "am";

const TARGET_RATE = 48_000;

export class Demodulator {
  private mode: DemodMode = "fm";
  private decim = 50;
  private prevPhase = 0;
  private prevI = 0;
  private prevQ = 0;
  private lp: Biquad;
  private hp: Biquad;
  private outCounter = 0;
  private hasPrev = false;

  constructor() {
    this.lp = new Biquad();
    this.hp = new Biquad();
    this.reset(2_400_000);
  }

  reset(sampleRate: number, mode?: DemodMode): void {
    if (mode) this.mode = mode;
    this.decim = Math.max(1, Math.round(sampleRate / TARGET_RATE));
    this.prevPhase = 0;
    this.prevI = 0;
    this.prevQ = 0;
    this.outCounter = 0;
    this.hasPrev = false;
    const cutoff = this.mode === "fm" ? 15_000 : this.mode === "nfm" ? 3_500 : 6_000;
    this.lp.reset().lowpass(sampleRate, cutoff);
    this.hp.reset().highpass(sampleRate, 80);
  }

  get outputSampleRate(): number {
    return 48_000;
  }

  process(iq: Float32Array): Float32Array {
    const n = iq.length / 2;
    const out: number[] = [];

    if (this.mode === "am") {
      const env = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const re = iq[i * 2];
        const im = iq[i * 2 + 1];
        env[i] = Math.sqrt(re * re + im * im);
      }
      const filtered = this.lp.process(this.hp.process(env));
      this.decimate(filtered, out);
    } else {
      const dev = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const re = iq[i * 2];
        const im = iq[i * 2 + 1];
        if (!this.hasPrev) {
          this.prevI = re;
          this.prevQ = im;
          this.hasPrev = true;
        }
        const phase = Math.atan2(im, re);
        let dphi = phase - this.prevPhase;
        if (dphi > Math.PI) dphi -= 2 * Math.PI;
        else if (dphi < -Math.PI) dphi += 2 * Math.PI;
        this.prevPhase = phase;
        dev[i] = dphi * this.decim * 48_000 / (2 * Math.PI);
      }
      const filtered = this.lp.process(dev);
      this.decimate(filtered, out);
    }

    return out.length > 0 ? Float32Array.from(out) : new Float32Array(0);
  }

  private decimate(input: Float32Array, out: number[]): void {
    for (let i = 0; i < input.length; i++) {
      if (this.outCounter % this.decim === 0) out.push(input[i]);
      this.outCounter++;
    }
  }
}
