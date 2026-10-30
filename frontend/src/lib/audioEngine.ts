export const EQ_FREQS = [120, 400, 1200, 3000, 8000];
export const EQ_LABELS = ["120", "400", "1.2k", "3k", "8k"];
export const EQ_TYPES: BiquadFilterType[] = ["lowshelf", "peaking", "peaking", "peaking", "highshelf"];
export const EQ_RANGE = 12;

export interface AudioSettings {
  eq: number[];
  denoise: boolean;
  denoiseAmount: number;
  limiter: boolean;
  limiterThreshold: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  eq: [0, 0, 0, 0, 0],
  denoise: true,
  denoiseAmount: 0.6,
  limiter: true,
  limiterThreshold: -10,
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private input: GainNode | null = null;
  private eq: BiquadFilterNode[] = [];
  private denoiser: AudioWorkletNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private next = 0;
  private initPromise: Promise<void> | null = null;
  private queue: Float32Array<ArrayBuffer>[] = [];
  private settings: AudioSettings;

  constructor(settings: AudioSettings) {
    this.settings = {
      eq: [...settings.eq],
      denoise: settings.denoise,
      denoiseAmount: settings.denoiseAmount,
      limiter: settings.limiter,
      limiterThreshold: settings.limiterThreshold,
    };
  }

  init(): void {
    if (this.initPromise) return;
    this.initPromise = this.doInit().catch((err) => {
      console.warn("audio init failed", err);
    });
  }

  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
  }

  private async doInit(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: 48000 });
    this.ctx = ctx;
    const input = ctx.createGain();
    this.input = input;

    let node: AudioNode = input;
    for (let i = 0; i < EQ_FREQS.length; i++) {
      const filter = ctx.createBiquadFilter();
      filter.type = EQ_TYPES[i];
      filter.frequency.value = EQ_FREQS[i];
      filter.Q.value = i === 0 || i === EQ_FREQS.length - 1 ? 0.7 : 1;
      filter.gain.value = this.settings.eq[i] ?? 0;
      node.connect(filter);
      node = filter;
      this.eq.push(filter);
    }

    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule("/denoiser-worklet.js");
        const denoiser = new AudioWorkletNode(ctx, "denoiser");
        denoiser.port.postMessage({
          amount: this.settings.denoise ? this.settings.denoiseAmount : 0,
        });
        node.connect(denoiser);
        node = denoiser;
        this.denoiser = denoiser;
      } catch (err) {
        console.warn("denoiser unavailable, playing without it", err);
      }
    }

    const limiter = ctx.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.applyLimiter(limiter);
    node.connect(limiter);
    node = limiter;
    this.limiter = limiter;

    node.connect(ctx.destination);
    if (ctx.state === "suspended") void ctx.resume();

    const queued = this.queue;
    this.queue = [];
    for (const data of queued) this.schedule(data);
  }

  push(data: Float32Array<ArrayBuffer>): void {
    if (!this.ctx) {
      this.queue.push(data);
      if (this.queue.length > 200) this.queue.shift();
      this.init();
      return;
    }
    this.schedule(data);
  }

  private schedule(data: Float32Array<ArrayBuffer>): void {
    const ctx = this.ctx;
    const input = this.input;
    if (!ctx || !input) return;
    if (ctx.state === "suspended") void ctx.resume();

    const buffer = ctx.createBuffer(1, data.length, 48000);
    buffer.copyToChannel(data, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(input);

    const now = ctx.currentTime;
    if (this.next < now + 0.02) this.next = now + 0.05;
    source.start(this.next);
    this.next += buffer.duration;
  }

  setEq(gains: number[]): void {
    this.settings.eq = [...gains];
    this.eq.forEach((filter, i) => {
      filter.gain.value = gains[i] ?? 0;
    });
  }

  setDenoise(enabled: boolean, amount: number): void {
    this.settings.denoise = enabled;
    this.settings.denoiseAmount = amount;
    this.denoiser?.port.postMessage({ amount: enabled ? amount : 0 });
  }

  setLimiter(enabled: boolean, thresholdDb: number): void {
    this.settings.limiter = enabled;
    this.settings.limiterThreshold = thresholdDb;
    if (this.limiter) this.applyLimiter(this.limiter);
  }

  private applyLimiter(node: DynamicsCompressorNode): void {
    node.threshold.value = this.settings.limiter ? this.settings.limiterThreshold : 0;
    node.ratio.value = this.settings.limiter ? 20 : 1;
  }

  dispose(): void {
    this.queue = [];
    this.eq = [];
    this.denoiser = null;
    this.input = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
