import { useEffect, useRef, useState } from "react";
import { client, type BandMeta, type ServerStatus } from "../lib/wsClient";
import { BANDS, fmtMHz, type BandPreset } from "../lib/bands";

interface Props {
  status: ServerStatus | null;
  band: BandPreset;
  onBandChange: (b: BandPreset) => void;
  cursorFreq: number | null;
  onCursor: (freq: number) => void;
  listening: boolean;
  onListen: (on: boolean) => void;
  onMode: (m: string) => void;
  onAgc: (on: boolean) => void;
  onGain: (g: number) => void;
}

const DB_MIN = -110;
const DB_MAX = -10;
const BG = "#0d1117";
const TARGET_PX_PER_SEC = 20;
const MIN_SPAN = 100e3;
const ZOOM_FACTOR = 1.4;

const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const r = clamp01(1.5 - Math.abs(4 * t - 3));
    const g = clamp01(1.5 - Math.abs(4 * t - 2));
    const b = clamp01(1.5 - Math.abs(4 * t - 1));
    lut[i * 4] = r * 255;
    lut[i * 4 + 1] = g * 255;
    lut[i * 4 + 2] = b * 255;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

interface ViewRange {
  start: number;
  stop: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function niceStep(span: number): number {
  const target = span / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const m = target / pow;
  const mult = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10;
  return mult * pow;
}

export function BandView({
  status,
  band,
  onBandChange,
  cursorFreq,
  onCursor,
  listening,
  onListen,
  onMode,
  onAgc,
  onGain,
}: Props) {
  const [view, setView] = useState<ViewRange>({ start: band.start, stop: band.stop });
  const [sweeping, setSweeping] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [passMs, setPassMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const wfRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const metaRef = useRef<BandMeta | null>(null);
  const frameRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const prevFrameRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const needsFillRef = useRef(true);
  const viewRef = useRef<ViewRange>(view);
  const cursorRef = useRef<number | null>(cursorFreq);
  const bandRef = useRef<BandPreset>(band);
  const listeningRef = useRef(listening);
  const lastRowAtRef = useRef(0);
  const passMsRef = useRef(300);
  const colorRangeRef = useRef({ lo: -90, hi: -40 });
  const levelRef = useRef<HTMLCanvasElement>(null);
  const levelBufRef = useRef<number[]>([]);
  const scanHitsRef = useRef<number[]>([]);

  const clearWaterfall = () => {
    const c = wfRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, c.width, c.height);
  };

  const clearOverlay = () => {
    const c = ovRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
  };

  const drawLevel = () => {
    const canvas = levelRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    const dbMin = -110;
    const dbMax = -10;
    ctx.font = "10px monospace";
    ctx.textBaseline = "top";
    for (let db = -100; db <= -20; db += 20) {
      const y = h - ((db - dbMin) / (dbMax - dbMin)) * h;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fillText(`${db}`, 3, y + 1);
    }

    const buf = levelBufRef.current;
    if (buf.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = w - buf.length + i;
        const y = h - clamp01((buf[i] - dbMin) / (dbMax - dbMin)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#3fb950";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const last = buf[buf.length - 1];
      ctx.fillStyle = "#3fb950";
      ctx.font = "12px monospace";
      ctx.fillText(`${last.toFixed(0)} dB`, w - 64, 4);
    }
  };

  const pushLevel = (db: number) => {
    const buf = levelBufRef.current;
    buf.push(db);
    const canvas = levelRef.current;
    const max = canvas ? canvas.width : 1400;
    if (buf.length > max) buf.splice(0, buf.length - max);
    drawLevel();
  };

  const drawWaterfall = () => {
    const canvas = wfRef.current;
    const m = metaRef.current;
    const d = frameRef.current;
    if (!canvas || !m || !d) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const v = viewRef.current;
    const w = canvas.width;
    const h = canvas.height;
    const n = d.length;
    const mSpan = m.stop - m.start;
    if (n === 0 || mSpan <= 0) return;

    const f0 = ((v.start - m.start) / mSpan) * (n - 1);
    const f1 = ((v.stop - m.start) / mSpan) * (n - 1);

    // предвычисляем диапазон бинов на каждый пиксель
    const idxA = new Int32Array(w);
    const idxB = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      const fa = f0 + (x / w) * (f1 - f0);
      const fb = f0 + ((x + 1) / w) * (f1 - f0);
      idxA[x] = Math.max(0, Math.min(n - 1, Math.floor(fa)));
      idxB[x] = Math.max(0, Math.min(n - 1, Math.ceil(fb)));
    }

    // peak-hold: в пределах пикселя берём максимум, чтобы узкие сигналы были видны
    const aggregate = (arr: Float32Array): Float32Array => {
      const out = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const a = idxA[x];
        const b = idxB[x];
        if (b - a <= 1) {
          const fa = f0 + (x / w) * (f1 - f0);
          const i0 = Math.max(0, Math.min(n - 1, Math.floor(fa)));
          const i1 = Math.min(n - 1, i0 + 1);
          const fr = fa - i0;
          out[x] = arr[i0] * (1 - fr) + arr[i1] * fr;
        } else {
          let m = -Infinity;
          for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i];
          out[x] = m;
        }
      }
      return out;
    };

    const rowCurrent = aggregate(d);

    // авто-диапазон цвета по уже агрегированной строке
    const aggSorted = Float32Array.from(rowCurrent).sort();
    const p5 = aggSorted[Math.floor(w * 0.05)];
    const p95 = aggSorted[Math.floor(w * 0.95)];
    const dataSpan = Math.max(12, p95 - p5);
    const lo = p5 - dataSpan * 0.1;
    const hi = p95 + dataSpan * 0.8;
    const cr = colorRangeRef.current;
    if (needsFillRef.current) {
      cr.lo = lo;
      cr.hi = hi;
    } else {
      cr.lo = cr.lo * 0.5 + lo * 0.5;
      cr.hi = cr.hi * 0.5 + hi * 0.5;
    }

    const writeRow = (a: Float32Array, b: Float32Array, t: number, pix: Uint8ClampedArray, offset: number) => {
      for (let x = 0; x < w; x++) {
        const val = a[x] * (1 - t) + b[x] * t;
        const c = Math.floor(clamp01((val - cr.lo) / Math.max(1, cr.hi - cr.lo)) * 255) * 4;
        const o = offset + x * 4;
        pix[o] = LUT[c];
        pix[o + 1] = LUT[c + 1];
        pix[o + 2] = LUT[c + 2];
        pix[o + 3] = 255;
      }
    };

    // заливаем весь холст только когда полоса уже полностью собрана
    // (иначе в начале получается «лесенка» из ещё не просканированных кусков)
    if (needsFillRef.current && m.complete) {
      const row = new ImageData(w, 1);
      writeRow(rowCurrent, rowCurrent, 0, row.data, 0);
      const off = document.createElement("canvas");
      off.width = w;
      off.height = 1;
      off.getContext("2d")!.putImageData(row, 0, 0);
      ctx.drawImage(off, 0, 0, w, h);
      needsFillRef.current = false;
      prevFrameRef.current = d;
      lastRowAtRef.current = performance.now();
      return;
    }

    // плавная прокрутка: интерполируем между прошлым и текущим кадром
    const now = performance.now();
    const pass = lastRowAtRef.current > 0 ? now - lastRowAtRef.current : passMsRef.current;
    lastRowAtRef.current = now;
    passMsRef.current = pass;
    setPassMs(Math.round(pass));
    const k = Math.max(1, Math.min(48, Math.round((TARGET_PX_PER_SEC * pass) / 1000)));

    const prev = prevFrameRef.current ?? d;
    const rowPrev = prevFrameRef.current ? aggregate(prev) : rowCurrent;
    const block = new ImageData(w, k);
    for (let i = 0; i < k; i++) {
      writeRow(rowPrev, rowCurrent, (i + 1) / k, block.data, i * w * 4);
    }
    ctx.drawImage(canvas, 0, -k);
    ctx.putImageData(block, 0, h - k);
    prevFrameRef.current = d;
  };

  const drawOverlay = () => {
    const canvas = ovRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const v = viewRef.current;
    const span = v.stop - v.start;
    if (span <= 0) return;

    // сетка частот (подписи рисуются в HTML-оси над канвасом)
    const step = niceStep(span);
    for (let k = Math.ceil(v.start / step); k * step <= v.stop; k++) {
      const x = ((k * step - v.start) / span) * w;
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // курсор — жёлтый пунктирный столбик на выбранной частоте
    const cf = cursorRef.current;
    if (cf != null && cf >= v.start && cf <= v.stop) {
      const x = ((cf - v.start) / span) * w;
      ctx.strokeStyle = "rgba(255,210,74,0.95)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // метки найденных сканером частот
    for (const hf of scanHitsRef.current) {
      if (hf < v.start || hf > v.stop) continue;
      const x = ((hf - v.start) / span) * w;
      ctx.strokeStyle = "rgba(63,185,80,0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(63,185,80,0.95)";
      ctx.beginPath();
      ctx.moveTo(x - 4, 0);
      ctx.lineTo(x + 4, 0);
      ctx.lineTo(x, 7);
      ctx.closePath();
      ctx.fill();
    }
  };

  const zoomTo = (freq: number, factor: number) => {
    const b = bandRef.current;
    const v = viewRef.current;
    const full = b.stop - b.start;
    let span = (v.stop - v.start) * factor;
    const minSpan = Math.max(MIN_SPAN, full / 64);
    span = Math.max(minSpan, Math.min(full, span));
    const frac = (freq - v.start) / (v.stop - v.start);
    let start = freq - frac * span;
    if (start < b.start) start = b.start;
    if (start + span > b.stop) start = b.stop - span;
    const next: ViewRange = { start, stop: start + span };
    if (Math.abs(next.start - v.start) < 1 && Math.abs(next.stop - v.stop) < 1) return;
    setView(next);
  };

  // зум колесом — вокруг указателя (native listener, чтобы preventDefault работал)
  useEffect(() => {
    const el = wfRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const v = viewRef.current;
      const rect = el.getBoundingClientRect();
      const frac = clamp01((ev.clientX - rect.left) / rect.width);
      const freq = v.start + frac * (v.stop - v.start);
      zoomTo(freq, ev.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // смена диапазона: сброс водопада, зума и подписок + запуск свипа
  useEffect(() => {
    bandRef.current = band;
    metaRef.current = null;
    frameRef.current = null;
    prevFrameRef.current = null;
    needsFillRef.current = true;
    hasDataRef.current = false;
    setHasData(false);
    lastRowAtRef.current = 0;
    passMsRef.current = 300;
    setView({ start: band.start, stop: band.stop });
    setSweeping(true);
    scanHitsRef.current = [];
    clearWaterfall();
    clearOverlay();

    // демо-режим (?demo=1): синтетические данные, если устройства нет
    if (new URLSearchParams(location.search).has("demo")) {
      const n = 2001;
      const meta: BandMeta = {
        start: band.start,
        stop: band.stop,
        binWidth: (band.stop - band.start) / (n - 1),
        binCount: n,
      };
      metaRef.current = meta;
      const span = band.stop - band.start;
      const carriers = Array.from({ length: 9 }, () => ({
        f: band.start + span * (0.03 + Math.random() * 0.94),
        w: 2 + Math.floor(Math.random() * 5),
      }));
      const gen = () => {
        if (listeningRef.current) return;
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = -104 + Math.random() * 6;
        for (const c of carriers) {
          const idx = Math.round(((c.f - band.start) / span) * (n - 1));
          for (let d = -c.w; d <= c.w; d++) {
            const gi = idx + d;
            if (gi < 0 || gi >= n) continue;
            const v = -55 - Math.abs(d) * 2.5 + Math.random() * 5;
            if (v > arr[gi]) arr[gi] = v;
          }
        }
        frameRef.current = arr;
        drawWaterfall();
        drawOverlay();
        if (!hasDataRef.current) {
          hasDataRef.current = true;
          setHasData(true);
        }
      };
      const t = window.setInterval(gen, 330);
      const levelTimer = window.setInterval(() => {
        if (!listeningRef.current) return;
        pushLevel(-70 + Math.sin(performance.now() / 600) * 8 + (Math.random() - 0.5) * 8);
      }, 90);
      gen();
      return () => {
        window.clearInterval(t);
        window.clearInterval(levelTimer);
      };
    }

    const u1 = client.onBandStart((m) => {
      metaRef.current = m;
      setSweeping(true);
      setError(null);
    });
    const u2 = client.onBandFrame((d) => {
      if (frameRef.current === d) return; // защита от двойной доставки кадра
      frameRef.current = d;
      drawWaterfall();
      drawOverlay();
      if (!hasDataRef.current) {
        hasDataRef.current = true;
        setHasData(true);
      }
    });
    const u3 = client.onError((msg) => {
      setSweeping(false);
      setError(msg);
    });
    const u5 = client.onScanResult((r) => {
      scanHitsRef.current = r.map((h) => h.frequency);
      drawOverlay();
    });
    const start = async () => {
      if (listeningRef.current) return;
      try {
        await client.startBand(band.start, band.stop);
      } catch {
        setSweeping(false);
      }
    };
    void start();

    return () => {
      u1();
      u2();
      u3();
      u5();
      void client.stopBand();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [band]);

  // изменение зума: перерисовываем подписи, старую картинку стираем
  useEffect(() => {
    viewRef.current = view;
    prevFrameRef.current = null;
    needsFillRef.current = true;
    lastRowAtRef.current = 0;
    clearWaterfall();
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    cursorRef.current = cursorFreq;
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorFreq]);

  useEffect(() => {
    listeningRef.current = listening;
    levelBufRef.current = [];
    if (listening) {
      requestAnimationFrame(() => drawLevel());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  // живой уровень на частоте приёма — отдельный график, не на спектре
  useEffect(() => {
    const unsub = client.onSpectrum((d) => {
      if (!listeningRef.current) return;
      const n = d.length;
      const center = n >> 1;
      const k = Math.max(2, Math.round(n * 0.04));
      let max = -200;
      for (let i = Math.max(0, center - k); i <= Math.min(n - 1, center + k); i++) {
        if (d[i] > max) max = d[i];
      }
      pushLevel(max);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // устройство подключилось — если данных ещё нет, заново запускаем свип
  useEffect(() => {
    if (status?.connected && !listeningRef.current && !hasDataRef.current) {
      void client.startBand(bandRef.current.start, bandRef.current.stop).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connected]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = clamp01((e.clientX - rect.left) / rect.width);
    const v = viewRef.current;
    onCursor(Math.round(v.start + frac * (v.stop - v.start)));
  };

  const fullSpan = band.stop - band.start;
  const viewSpan = view.stop - view.start;
  const zoom = fullSpan / viewSpan;
  const tickStep = viewSpan > 0 ? niceStep(viewSpan) : 1;
  const ticks: number[] = [];
  if (viewSpan > 0) {
    for (let k = Math.ceil(view.start / tickStep); k * tickStep <= view.stop; k++) ticks.push(k * tickStep);
  }
  const cursorPct =
    cursorFreq != null && viewSpan > 0 && cursorFreq >= view.start && cursorFreq <= view.stop
      ? ((cursorFreq - view.start) / viewSpan) * 100
      : null;

  return (
    <div className="band-view">
      <div className="tuner">
        <label className="band-label">Диапазон:</label>
        <select value={band.name} onChange={(e) => onBandChange(BANDS.find((b) => b.name === e.target.value)!)}>
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
        <label className="chk">
          <input type="checkbox" checked={status?.agc ?? true} onChange={(e) => onAgc(e.target.checked)} />
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
        <div className="zoom">
          <button title="Приблизить" onClick={() => zoomTo(cursorRef.current ?? (view.start + view.stop) / 2, 1 / ZOOM_FACTOR)}>
            +
          </button>
          <span className="zoom-range">
            {fmtMHz(view.start)}–{fmtMHz(view.stop)} МГц{zoom > 1.05 ? ` · ×${zoom.toFixed(1)}` : ""}
          </span>
          <button title="Отдалить" onClick={() => zoomTo(cursorRef.current ?? (view.start + view.stop) / 2, ZOOM_FACTOR)}>
            −
          </button>
          <button title="Сбросить зум" onClick={() => setView({ start: band.start, stop: band.stop })}>
            Сброс
          </button>
        </div>
        <span className="sweep-status">
          {listening
            ? "свип на паузе (прослушивание)"
            : sweeping
              ? `свип…${passMs ? ` ${(passMs / 1000).toFixed(1)} с/проход` : ""}`
              : "свип остановлен"}
        </span>
        <button className={listening ? "listen stop" : "listen"} onClick={() => onListen(!listening)}>
          {listening ? "■ Стоп" : "▶ Слушать"}
        </button>
      </div>
      <div className="freq-axis">
        {ticks.map((f) => {
          const pct = ((f - view.start) / viewSpan) * 100;
          const transform = pct < 1.5 ? "translateX(0)" : pct > 98.5 ? "translateX(-100%)" : "translateX(-50%)";
          return (
            <span key={f} className="freq-tick" style={{ left: `${pct}%`, transform }}>
              {fmtMHz(f)}
            </span>
          );
        })}
        {cursorPct != null && (
          <span className="freq-tick freq-tick-cursor" style={{ left: `${cursorPct}%` }}>
            {fmtMHz(cursorFreq!)}
          </span>
        )}
      </div>
      <div className="waterfall-wrap">
        <canvas ref={wfRef} className="waterfall big" width={1400} height={600} onClick={handleClick} />
        <canvas ref={ovRef} className="waterfall-overlay" width={1400} height={600} />
        {error && <div className="wf-error">{error}</div>}
        {!new URLSearchParams(location.search).has("demo") && (!status?.connected || !hasData) && (
          <div className="wf-empty">
            {status?.connected
              ? "Ожидание данных свипа…"
              : "Устройство не подключено — подключите RTL-SDR по USB и запустите агент в тулбаре"}
          </div>
        )}
      </div>
      {listening && (
        <div className="level-panel">
          <div className="level-title">
            Амплитуда на частоте {cursorFreq != null ? `${fmtMHz(cursorFreq)} МГц` : "приёма"} — живой график
          </div>
          <canvas ref={levelRef} width={1400} height={90} />
        </div>
      )}
    </div>
  );
}
