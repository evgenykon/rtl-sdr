import { RtlTcpClient } from "./rtlTcpClient.js";
import { StreamHub, FRAME_SPECTRUM, FRAME_AUDIO, FRAME_BAND } from "../ws/streams.js";
import { fft, spectrumDb } from "../dsp/fft.js";
import { Demodulator, type DemodMode } from "../dsp/demod.js";
import { runScan, type ScanHit, type ScanOptions } from "../dsp/scanner.js";
import { config } from "../config.js";

const MAX_QUEUE_SAMPLES = 2_400_000;
const SCAN_FRAMES = 6;
const BAND_FRAMES = 2;
const BAND_STEP_FRAC = 0.8; // шаг центров = 80% полосы приёма (20% перекрытие), меньше центров — быстрее свип
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function chunkMedian(spectrum: Float32Array): number {
  const vals: number[] = [];
  const from = Math.floor(spectrum.length * 0.1);
  const to = Math.floor(spectrum.length * 0.9);
  for (let i = from; i < to; i += 16) vals.push(spectrum[i]);
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : -100;
}

export interface BandSweepOptions {
  settleMs?: number;
  frames?: number;
}

export interface DeviceStatus {
  connected: boolean;
  tunerName: string;
  gainCount: number;
  sampleRate: number;
  frequency: number;
  gainMode: 0 | 1;
  gain: number;
  agc: boolean;
  directSampling: number;
  biasTee: boolean;
  listening: boolean;
  audioMode: DemodMode;
  scanning: boolean;
  scanResults: number;
  bandSweeping: boolean;
}

export class DeviceManager {
  private client: RtlTcpClient;
  private hub: StreamHub;
  private queue: Float32Array[] = [];
  private queued = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private fftRe = new Float32Array(config.fftSize);
  private fftIm = new Float32Array(config.fftSize);
  private spectrumOut = new Float32Array(config.fftSize);
  private demod = new Demodulator();
  private listening = false;
  private audioMode: DemodMode = "fm";
  private scanMode = false;
  private scanCancelled = false;
  private scanRunning = false;
  private lastScanResults: ScanHit[] = [];
  private bandSweeping = false;
  private bandCancel = false;
  private bandLoopPromise: Promise<void> | null = null;

  constructor(hub: StreamHub) {
    this.hub = hub;
    hub.onEmpty = () => {
      this.stopBandSweep();
      this.cancelScan();
      if (this.listening) this.setListening(false);
    };
    this.client = new RtlTcpClient({
      onStatus: (connected) => this.broadcastStatus(),
      onSamples: (iq) => this.onSamples(iq),
      onError: (err) => this.hub.broadcastJson({ type: "error", message: err.message }),
    });
  }

  start(): void {
    this.client.connect();
    this.tickTimer = setInterval(() => this.tick(), 1000 / config.spectrumFps);
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.client.dispose();
  }

  private onSamples(iq: Float32Array): void {
    this.queue.push(iq);
    this.queued += iq.length;
    while (this.queued > MAX_QUEUE_SAMPLES * 2) {
      const head = this.queue.shift();
      if (!head) break;
      this.queued -= head.length;
    }
  }

  private takeSamples(complexCount: number): Float32Array {
    const total = complexCount * 2;
    const out = new Float32Array(total);
    let written = 0;
    while (written < total) {
      const head = this.queue[0];
      const need = total - written;
      if (head.length <= need) {
        out.set(head, written);
        written += head.length;
        this.queue.shift();
        this.queued -= head.length;
      } else {
        out.set(head.subarray(0, need), written);
        this.queue[0] = head.subarray(need);
        this.queued -= need;
        written += need;
      }
    }
    return out;
  }

  private clearQueue(): void {
    this.queue = [];
    this.queued = 0;
  }

  private tick(): void {
    if (this.scanMode) return;
    const available = Math.floor(this.queued / 2);
    if (available < config.fftSize) return;

    const block = this.takeSamples(available);
    const n = block.length / 2;
    const start = (n - config.fftSize) * 2;
    for (let i = 0; i < config.fftSize; i++) {
      this.fftRe[i] = block[start + i * 2];
      this.fftIm[i] = block[start + i * 2 + 1];
    }
    fft(this.fftRe, this.fftIm);
    spectrumDb(this.fftRe, this.fftIm, this.spectrumOut);
    this.hub.broadcastFloat32(FRAME_SPECTRUM, this.spectrumOut);

    if (this.listening) {
      const pcm = this.demod.process(block);
      if (pcm.length > 0) this.hub.broadcastFloat32(FRAME_AUDIO, pcm);
    }
  }

  private async collectSpectrum(
    frames = SCAN_FRAMES,
    fresh = false,
  ): Promise<{ spectrum: Float32Array; sampleRate: number }> {
    // после перестройки в очереди могут быть сэмплы старой частоты —
    // сбрасываем буфер и ждём только свежие данные
    if (fresh) this.clearQueue();
    const need = frames * config.fftSize;
    const deadline = Date.now() + 6000;
    while (this.queued / 2 < need) {
      if (Date.now() > deadline) throw new Error("No samples received from rtl_tcp");
      await new Promise((r) => setTimeout(r, 5));
    }
    const block = this.takeSamples(need);
    const sampleRate = this.client.currentSampleRate;
    const avg = new Float32Array(config.fftSize);
    for (let f = 0; f < frames; f++) {
      const off = f * config.fftSize * 2;
      for (let i = 0; i < config.fftSize; i++) {
        this.fftRe[i] = block[off + i * 2];
        this.fftIm[i] = block[off + i * 2 + 1];
      }
      fft(this.fftRe, this.fftIm);
      spectrumDb(this.fftRe, this.fftIm, this.spectrumOut);
      for (let i = 0; i < config.fftSize; i++) avg[i] += this.spectrumOut[i];
    }
    for (let i = 0; i < avg.length; i++) avg[i] /= frames;
    return { spectrum: avg, sampleRate };
  }

  tune(freq: number): void {
    this.client.setFrequency(Math.round(freq));
    this.clearQueue();
    this.broadcastStatus();
  }

  setSampleRate(hz: number): void {
    this.client.setSampleRate(hz);
    this.demod.reset(hz, this.audioMode);
    this.clearQueue();
    this.broadcastStatus();
  }

  setGainMode(mode: 0 | 1): void {
    this.client.setGainMode(mode);
    this.broadcastStatus();
  }

  setGain(tenthsDb: number): void {
    this.client.setGain(tenthsDb);
    this.broadcastStatus();
  }

  setAgc(enabled: boolean): void {
    this.client.setAgc(enabled);
    this.broadcastStatus();
  }

  setAudioMode(mode: DemodMode): void {
    this.audioMode = mode;
    this.demod.reset(this.client.currentSampleRate, mode);
    this.broadcastStatus();
  }

  setListening(on: boolean): void {
    if (on && this.bandSweeping) this.stopBandSweep();
    if (on) {
      this.demod.reset(this.client.currentSampleRate, this.audioMode);
    }
    this.listening = on;
    this.clearQueue();
    this.broadcastStatus();
  }

  async startScan(options: ScanOptions): Promise<ScanHit[]> {
    if (this.scanRunning) throw new Error("Scan already running");
    // свип полосы и скан не могут работать одновременно (один приёмник)
    if (this.bandLoopPromise) {
      this.bandCancel = true;
      await this.bandLoopPromise.catch(() => {});
    }
    this.scanRunning = true;
    this.scanMode = true;
    this.scanCancelled = false;
    if (this.listening) this.setListening(false);
    this.clearQueue();
    try {
      const results = await runScan(options, {
        onProgress: (p) => this.hub.broadcastJson({ type: "scan-progress", ...p }),
        tune: (f) => {
          this.client.setFrequency(Math.round(f));
          this.clearQueue();
        },
        collect: () => this.collectSpectrum(SCAN_FRAMES, true),
        settle: () => sleep(config.scanSettleMs),
        isCancelled: () => this.scanCancelled,
      });
      this.lastScanResults = results;
      this.hub.broadcastJson({
        type: "scan-result",
        results,
        thresholdDb: options.thresholdDb,
        range: [options.startHz, options.stopHz],
      });
      return results;
    } finally {
      this.scanMode = false;
      this.scanRunning = false;
      this.clearQueue();
      this.broadcastStatus();
    }
  }

  cancelScan(): void {
    this.scanCancelled = true;
  }

  async startBandSweep(startHz: number, stopHz: number, options: BandSweepOptions = {}): Promise<void> {
    if (this.scanRunning) throw new Error("Scan already running");
    if (this.bandLoopPromise) {
      this.bandCancel = true;
      await this.bandLoopPromise.catch(() => {});
    }
    const settleMs = Math.min(1000, Math.max(10, Math.round(options.settleMs ?? config.bandSettleMs)));
    const frames = Math.min(8, Math.max(1, Math.round(options.frames ?? BAND_FRAMES)));
    this.bandSweeping = true;
    this.bandCancel = false;
    this.scanMode = true;
    if (this.listening) this.setListening(false);
    this.clearQueue();

    const sr = this.client.currentSampleRate;
    const fftSize = config.fftSize;
    const binWidth = sr / fftSize;
    const half = sr / 2;
    const step = sr * BAND_STEP_FRAC;
    const binCount = Math.ceil((stopHz - startHz) / binWidth) + 1;
    const centers: number[] = [];
    if (stopHz - startHz <= sr) {
      // Узкая полоса: хватает одного перестроения на весь диапазон.
      centers.push((startHz + stopHz) / 2);
    } else {
      for (let c = startHz + half; c < stopHz - half; c += step) centers.push(c);
      centers.push(stopHz - half);
    }

    this.hub.broadcastJson({
      type: "band-start",
      start: startHz,
      stop: stopHz,
      binWidth,
      binCount,
      settleMs,
      frames,
    });
    this.broadcastStatus();

    this.bandLoopPromise = this.runBandLoop(
      centers,
      binCount,
      fftSize,
      binWidth,
      half,
      startHz,
      stopHz,
      settleMs,
      frames,
    );
    this.bandLoopPromise.catch(() => {});
  }

  private async runBandLoop(
    centers: number[],
    binCount: number,
    fftSize: number,
    binWidth: number,
    half: number,
    startHz: number,
    stopHz: number,
    settleMs: number,
    frames: number,
  ): Promise<void> {
    const band = new Float32Array(binCount).fill(-140);
    const stepBins = centers.length > 1 ? Math.round((centers[1] - centers[0]) / binWidth) : 0;
    let refMedian: number | null = null;
    let complete = false;
    try {
      while (!this.bandCancel) {
        // собираем ПОЛНУЮ строку полосы за один проход
        for (const c of centers) {
          if (this.bandCancel) break;
          this.client.setFrequency(Math.round(c));
          this.clearQueue();
          await sleep(settleMs);
          const { spectrum } = await this.collectSpectrum(frames, true);
          const base = Math.round((c - half - startHz) / binWidth);
          // вырезаем DC-спайк в центре перестройки
          const dcIdx = fftSize >> 1;
          const notchHalf = 20;
          const shoulderLo = spectrum[Math.max(0, dcIdx - notchHalf - 10)];
          const shoulderHi = spectrum[Math.min(fftSize - 1, dcIdx + notchHalf + 10)];
          const notchVal = (shoulderLo + shoulderHi) / 2;
          for (let i = dcIdx - notchHalf; i <= dcIdx + notchHalf; i++) {
            if (i >= 0 && i < fftSize) spectrum[i] = notchVal;
          }
          // выравниваем уровень куска по шумовому полу — без «ступенек»
          const med = chunkMedian(spectrum);
          if (refMedian == null) refMedian = med;
          else refMedian = refMedian * 0.98 + med * 0.02;
          const shift = refMedian - med;
          // сглаживаем шов в зоне перекрытия с предыдущим куском
          const overlapEnd = base + (stepBins > 0 ? Math.max(0, fftSize - stepBins) : 0);
          for (let i = 0; i < fftSize; i++) {
            const g = base + i;
            if (g < 0 || g >= binCount) continue;
            const v = spectrum[i] + shift;
            if (stepBins > 0 && g >= base && g < overlapEnd) {
              const w = (g - base) / Math.max(1, overlapEnd - base);
              band[g] = band[g] * (1 - w) + v * w;
            } else {
              band[g] = v;
            }
          }
        }
        complete = true;
        if (!this.bandCancel) {
          this.hub.broadcastJson({
            type: "band-start",
            start: startHz,
            stop: stopHz,
            binWidth,
            binCount,
            complete,
          });
          this.hub.broadcastFloat32(FRAME_BAND, band);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("band sweep failed:", message);
      this.hub.broadcastJson({ type: "error", message: `Свип остановлен: ${message}` });
    } finally {
      this.bandSweeping = false;
      this.scanMode = false;
      this.clearQueue();
      this.broadcastStatus();
    }
  }

  stopBandSweep(): void {
    this.bandCancel = true;
  }

  getStatus(): DeviceStatus {
    return {
      connected: this.client.isConnected,
      tunerName: this.client.tunerName,
      gainCount: this.client.deviceInfo.gainCount,
      sampleRate: this.client.currentSampleRate,
      frequency: this.client.currentFrequency,
      gainMode: this.client.gainModeValue,
      gain: this.client.gainValue,
      agc: this.client.agcEnabled,
      directSampling: this.client.directSamplingValue,
      biasTee: this.client.biasTeeEnabled,
      listening: this.listening,
      audioMode: this.audioMode,
      scanning: this.scanRunning,
      scanResults: this.lastScanResults.length,
      bandSweeping: this.bandSweeping,
    };
  }

  getLastScan(): ScanHit[] {
    return this.lastScanResults;
  }

  broadcastError(message: string): void {
    this.hub.broadcastJson({ type: "error", message });
  }

  private broadcastStatus(): void {
    this.hub.broadcastJson({ type: "status", ...this.getStatus() });
  }
}
