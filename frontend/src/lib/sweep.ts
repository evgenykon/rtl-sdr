export interface SweepOptions {
  settleMs: number;
  frames: number;
}

export const SWEEP_PRESETS = [
  { id: "fast", name: "Быстро", settleMs: 40, frames: 1 },
  { id: "normal", name: "Средне", settleMs: 90, frames: 2 },
  { id: "precise", name: "Точно", settleMs: 200, frames: 4 },
] as const;

export type SweepPresetId = (typeof SWEEP_PRESETS)[number]["id"];

const STORAGE_KEY = "rtl-sdr.sweep-preset";
const DEFAULT_PRESET: SweepPresetId = "fast";

export function loadSweepPreset(): SweepPresetId {
  const saved = localStorage.getItem(STORAGE_KEY);
  const found = SWEEP_PRESETS.find((p) => p.id === saved);
  return found ? found.id : DEFAULT_PRESET;
}

export function saveSweepPreset(id: SweepPresetId): void {
  localStorage.setItem(STORAGE_KEY, id);
}

export function sweepOptions(id: SweepPresetId = loadSweepPreset()): SweepOptions {
  const preset = SWEEP_PRESETS.find((p) => p.id === id) ?? SWEEP_PRESETS[0];
  return { settleMs: preset.settleMs, frames: preset.frames };
}
