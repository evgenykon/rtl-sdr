export interface BandPreset {
  name: string;
  start: number;
  stop: number;
  mode: "fm" | "am" | "nfm";
}

export const BANDS: BandPreset[] = [
  { name: "FM 87.5–108 МГц", start: 87.5e6, stop: 108e6, mode: "fm" },
  { name: "Авиа 118–137 МГц", start: 118e6, stop: 137e6, mode: "am" },
  { name: "NOAA 162.4–162.55 МГц", start: 162.4e6, stop: 162.55e6, mode: "nfm" },
  { name: "2м 144–148 МГц", start: 144e6, stop: 148e6, mode: "nfm" },
  { name: "70см 430–440 МГц", start: 430e6, stop: 440e6, mode: "nfm" },
  { name: "PMR 446 МГц", start: 446e6, stop: 446.2e6, mode: "nfm" },
];

export function fmtMHz(hz: number): string {
  return (hz / 1e6).toFixed(hz % 1e6 === 0 ? 0 : 3);
}

export function fmtKHz(hz: number): string {
  return (hz / 1e3).toFixed(hz % 1e3 === 0 ? 0 : 1);
}
