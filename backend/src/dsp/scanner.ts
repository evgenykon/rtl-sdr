export interface ScanHit {
  frequency: number;
  powerDb: number;
  bandwidthHz: number;
}

export interface ScanOptions {
  startHz: number;
  stopHz: number;
  thresholdDb: number;
  /** Минимальное превышение над шумом, дБ (чувствительность). Больше — строже. */
  minSnrDb?: number;
}

export interface ScanHooks {
  onProgress: (progress: { center: number; index: number; total: number }) => void;
  settle: () => Promise<void>;
  tune: (freq: number) => void;
  collect: () => Promise<{ spectrum: Float32Array; sampleRate: number }>;
  isCancelled: () => boolean;
}


const FFT_BIN_OVERLAP = 2;
const SMOOTH_RADIUS = 1;
const LOCAL_MAX_RADIUS = 2;
const MIN_BANDWIDTH_HZ = 500; // ~2 бина: узкие несущие тоже сигналы
const MERGE_GAP_HZ = 20_000; // попадания ближе 15 кГц считаем одним сигналом

/** Медиана спектра — оценка шумового пола (устойчива к узким сигналам). */
function noiseFloorDb(spectrum: Float32Array): number {
  const vals: number[] = [];
  for (let i = 0; i < spectrum.length; i += 7) vals.push(spectrum[i]);
  vals.sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : -120;
}

export async function runScan(options: ScanOptions, hooks: ScanHooks): Promise<ScanHit[]> {
  const { startHz, stopHz, thresholdDb } = options;
  const first = await hooks.collect();
  const sampleRate = first.sampleRate;
  const fftSize = first.spectrum.length;
  const binWidth = sampleRate / fftSize;

  const step = sampleRate / 2;
  const centers: number[] = [];
  for (let c = startHz; c <= stopHz; c += step) centers.push(c);
  if (centers.length === 0 || centers[centers.length - 1] < stopHz) centers.push(stopHz);

  const rawHits: ScanHit[] = [];

  for (let i = 0; i < centers.length; i++) {
    if (hooks.isCancelled()) break;
    const center = centers[i];
    hooks.tune(center);
    await hooks.settle();
    const { spectrum } = await hooks.collect();
    hooks.onProgress({ center, index: i, total: centers.length });

    const noise = noiseFloorDb(spectrum);
    const floor = Math.max(thresholdDb, noise + (options.minSnrDb ?? 8));

    // сглаживаем, чтобы одиночные шумовые бины не считались сигналами
    const sm = new Float32Array(fftSize);
    for (let b = 0; b < fftSize; b++) {
      let sum = 0;
      let cnt = 0;
      for (let d = -SMOOTH_RADIUS; d <= SMOOTH_RADIUS; d++) {
        const idx = b + d;
        if (idx >= 0 && idx < fftSize) {
          sum += spectrum[idx];
          cnt++;
        }
      }
      sm[b] = sum / cnt;
    }

    const covered = new Uint8Array(fftSize);
    const dcBin = fftSize >> 1; // DC-спайк RTL-SDR — не считаем сигналом
    for (let b = LOCAL_MAX_RADIUS; b < fftSize - LOCAL_MAX_RADIUS; b++) {
      const power = sm[b];
      if (power < floor || covered[b]) continue;
      if (Math.abs(b - dcBin) <= 40) continue; // DC/артефакт перестройки

      // локальный максимум в окне ±LOCAL_MAX_RADIUS (один пик на сигнал)
      let isPeak = true;
      for (let d = 1; d <= LOCAL_MAX_RADIUS; d++) {
        if (sm[b] < sm[b - d] || sm[b] <= sm[b + d]) {
          isPeak = false;
          break;
        }
      }
      if (!isPeak) continue;

      let lo = b;
      let hi = b;
      while (lo > 0 && spectrum[lo - 1] >= floor) lo--;
      while (hi < fftSize - 1 && spectrum[hi + 1] >= floor) hi++;
      const bins = hi - lo + 1;
      if (bins * binWidth < MIN_BANDWIDTH_HZ) continue;
      // один сигнал на непрерывную область выше порога
      for (let k = lo; k <= hi; k++) covered[k] = 1;
      const bandwidthHz = bins * binWidth;

      const frequency = center + (b - fftSize / 2) * binWidth;
      if (frequency < startHz || frequency > stopHz) continue;
      rawHits.push({ frequency, powerDb: power, bandwidthHz });
    }
  }

  rawHits.sort((a, b) => a.frequency - b.frequency);
  const merged: ScanHit[] = [];
  let group: ScanHit[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const best = group.reduce((a, b) => (b.powerDb > a.powerDb ? b : a));
    const lo = Math.min(...group.map((h) => h.frequency - h.bandwidthHz / 2));
    const hi = Math.max(...group.map((h) => h.frequency + h.bandwidthHz / 2));
    merged.push({
      frequency: best.frequency,
      powerDb: best.powerDb,
      bandwidthHz: Math.max(best.bandwidthHz, hi - lo),
    });
    group = [];
  };
  for (const hit of rawHits) {
    if (group.length > 0 && hit.frequency - group[group.length - 1].frequency > MERGE_GAP_HZ) {
      flush();
    }
    group.push(hit);
  }
  flush();
  merged.sort((a, b) => a.frequency - b.frequency);
  return merged;
}
