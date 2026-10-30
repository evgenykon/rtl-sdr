import { useEffect, useState } from "react";
import { client, type ScanHit } from "../lib/wsClient";
import { BANDS, fmtKHz, fmtMHz } from "../lib/bands";

interface Props {
  onHit: (freq: number) => void;
  onFinished?: () => void;
}

export function Scanner({ onHit, onFinished }: Props) {
  const [band, setBand] = useState(BANDS[0]);
  const [sensitivity, setSensitivity] = useState(4);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ index: 0, total: 0 });
  const [results, setResults] = useState<ScanHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const u1 = client.onScanProgress((p) => {
      setProgress(p);
      setRunning(true);
    });
    const u2 = client.onScanResult((r) => {
      setResults(r);
      setRunning(false);
      setError(null);
      onFinished?.();
    });
    return () => {
      u1();
      u2();
    };
  }, []);

  const minSnr = 16 - sensitivity;

  const start = async () => {
    setError(null);
    setResults([]);
    setRunning(true);
    try {
      await client.startScan(band.start, band.stop, -110, minSnr);
    } catch (e: any) {
      setError(e.message ?? "Ошибка сканирования");
      setRunning(false);
    }
  };

  const cancel = async () => {
    await client.cancelScan();
    setRunning(false);
    onFinished?.();
  };

  return (
    <div className="scanner">
      <h3>Сканер частот</h3>
      <div className="row">
        <select value={band.name} onChange={(e) => setBand(BANDS.find((b) => b.name === e.target.value)!)}>
          {BANDS.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>
          Чувствительность: <b>{sensitivity}/10</b>
          <span className="sens-hint"> · порог +{minSnr.toFixed(0)} дБ над шумом</span>
        </label>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={sensitivity}
          onChange={(e) => setSensitivity(Number(e.target.value))}
        />
      </div>
      <div className="sens-hint">Выше — больше слабых сигналов (и риск ложных). Ниже — только сильные.</div>
      <div className="row">
        <button onClick={start} disabled={running} className="primary">
          {running ? "Сканирование…" : "Начать скан"}
        </button>
        {running && <button onClick={cancel}>Отмена</button>}
      </div>
      {running && (
        <div className="progress">
          <div
            className="bar"
            style={{ width: `${progress.total ? ((progress.index + 1) / progress.total) * 100 : 0}%` }}
          />
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {results.length > 0 && (
        <div className="sens-hint">Найдено: {results.length}</div>
      )}
      {results.length > 0 && (
        <table className="hits">
          <thead>
            <tr>
              <th>МГц</th>
              <th>Уровень</th>
              <th>Полоса</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={`${r.frequency}-${r.powerDb}`} onClick={() => onHit(r.frequency)}>
                <td>{fmtMHz(r.frequency)}</td>
                <td>{r.powerDb.toFixed(0)} dB</td>
                <td>{fmtKHz(r.bandwidthHz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
