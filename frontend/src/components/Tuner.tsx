import { useEffect, useState } from "react";
import type { ServerStatus } from "../lib/wsClient";
import { BANDS, fmtMHz } from "../lib/bands";

interface Props {
  status: ServerStatus | null;
  onTune: (freq: number) => void;
  onMode: (mode: string) => void;
  onListen: (on: boolean) => void;
  onAgc: (on: boolean) => void;
  onGain: (tenthsDb: number) => void;
  onSampleRate: (sr: number) => void;
}

const SAMPLE_RATES = [1_024_000, 2_048_000, 2_400_000, 3_200_000];

export function Tuner({ status, onTune, onMode, onListen, onAgc, onGain, onSampleRate }: Props) {
  const [freqKHz, setFreqKHz] = useState(100_000);
  const [band, setBand] = useState("");

  useEffect(() => {
    if (status) setFreqKHz(Math.round(status.frequency / 1000));
  }, [status?.frequency]);

  const connected = status?.connected ?? false;

  return (
    <div className="tuner">
      <span className={`dot ${connected ? "on" : "off"}`} title={connected ? "rtl_tcp подключён" : "rtl_tcp недоступен"} />
      <span className="dev-name">{status?.tunerName ?? "—"}</span>

      <input
        type="number"
        value={freqKHz}
        onChange={(e) => setFreqKHz(Number(e.target.value) || 0)}
        onKeyDown={(e) => e.key === "Enter" && onTune(freqKHz * 1000)}
        className="freq-input"
        step={25}
        min={24000}
        max={1766000}
      />
      <span className="unit">кГц</span>
      <button onClick={() => onTune(freqKHz * 1000)}>Тюнер</button>
      <button onClick={() => onTune((freqKHz - 12.5) * 1000)}>−12.5к</button>
      <button onClick={() => onTune((freqKHz + 12.5) * 1000)}>+12.5к</button>

      <label className="band-label">Диапазон:</label>
      <select
        value={band}
        onChange={(e) => {
          const selected = BANDS.find((b) => b.name === e.target.value);
          if (selected) {
            setBand(selected.name);
            onMode(selected.mode);
            onTune(selected.start);
          }
        }}
        className="band-select"
      >
        <option value="" disabled>
          выберите…
        </option>
        {BANDS.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}
          </option>
        ))}
      </select>

      <select value={status?.audioMode ?? "fm"} onChange={(e) => onMode(e.target.value)}>
        <option value="fm">FM</option>
        <option value="nfm">NFM</option>
        <option value="am">AM</option>
      </select>

      <select
        value={status?.sampleRate ?? 2_400_000}
        onChange={(e) => onSampleRate(Number(e.target.value))}
      >
        {SAMPLE_RATES.map((sr) => (
          <option key={sr} value={sr}>
            {(sr / 1e6).toFixed(3)} MS/s
          </option>
        ))}
      </select>

      <label className="chk">
        <input
          type="checkbox"
          checked={status?.agc ?? true}
          onChange={(e) => onAgc(e.target.checked)}
        />
        AGC
      </label>

      <div className="gain">
        <label>Усиление</label>
        <input
          type="range"
          min={0}
          max={496}
          step={1}
          value={status?.gain ?? 0}
          disabled={status?.agc ?? true}
          onChange={(e) => onGain(Number(e.target.value))}
        />
        <span>{((status?.gain ?? 0) / 10).toFixed(1)} dB</span>
      </div>

      <button
        className={status?.listening ? "listen stop" : "listen"}
        onClick={() => onListen(!(status?.listening ?? false))}
      >
        {status?.listening ? "■ Стоп" : "▶ Слушать"}
      </button>
    </div>
  );
}
