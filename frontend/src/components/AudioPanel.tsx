import { EQ_FREQS, EQ_LABELS, EQ_RANGE } from "../lib/audioEngine";

interface Props {
  eq: number[];
  denoise: boolean;
  denoiseAmount: number;
  limiter: boolean;
  limiterThreshold: number;
  onEq: (index: number, gain: number) => void;
  onDenoise: (on: boolean) => void;
  onDenoiseAmount: (amount: number) => void;
  onLimiter: (on: boolean) => void;
  onLimiterThreshold: (db: number) => void;
  onEqReset: () => void;
}

export function AudioPanel({
  eq,
  denoise,
  denoiseAmount,
  limiter,
  limiterThreshold,
  onEq,
  onDenoise,
  onDenoiseAmount,
  onLimiter,
  onLimiterThreshold,
  onEqReset,
}: Props) {
  return (
    <div className="audio-panel">
      <div className="audio-title">Аудио · эквалайзер, дБ</div>
      <div className="eq">
        {EQ_FREQS.map((freq, i) => (
          <label key={freq} className="eq-band" title={`${freq} Гц`}>
            <em>
              {(eq[i] ?? 0) > 0 ? "+" : ""}
              {eq[i] ?? 0}
            </em>
            <input
              type="range"
              min={-EQ_RANGE}
              max={EQ_RANGE}
              step={1}
              value={eq[i] ?? 0}
              onChange={(e) => onEq(i, Number(e.target.value))}
            />
            <span>{EQ_LABELS[i]}</span>
          </label>
        ))}
      </div>
      <button type="button" className="eq-reset" onClick={onEqReset} title="Сбросить эквалайзер">
        Сброс эквалайзера
      </button>
      <div className="denoise">
        <label className="chk">
          <input type="checkbox" checked={denoise} onChange={(e) => onDenoise(e.target.checked)} />
          Шумоподавление
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(denoiseAmount * 100)}
          disabled={!denoise}
          onChange={(e) => onDenoiseAmount(Number(e.target.value) / 100)}
          title="Сила шумоподавления"
        />
        <span>{Math.round(denoiseAmount * 100)}%</span>
      </div>
      <div className="denoise">
        <label className="chk">
          <input type="checkbox" checked={limiter} onChange={(e) => onLimiter(e.target.checked)} />
          Лимитер
        </label>
        <input
          type="range"
          min={-24}
          max={0}
          step={1}
          value={limiterThreshold}
          disabled={!limiter}
          onChange={(e) => onLimiterThreshold(Number(e.target.value))}
          title="Порог лимитера"
        />
        <span>{limiterThreshold} dB</span>
      </div>
    </div>
  );
}
