import { useEffect, useRef, useState } from "react";
import { client, type ServerStatus } from "./lib/wsClient";
import { BANDS, type BandPreset } from "./lib/bands";
import { BandView } from "./components/BandView";
import { Scanner } from "./components/Scanner";
import { AudioPanel } from "./components/AudioPanel";
import { fmtMHz } from "./lib/bands";
import { sweepOptions } from "./lib/sweep";
import { AudioEngine, DEFAULT_AUDIO_SETTINGS, EQ_FREQS, type AudioSettings } from "./lib/audioEngine";

export default function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [streamFps, setStreamFps] = useState(0);
  const [band, setBand] = useState<BandPreset>(BANDS[0]);
  const [cursorFreq, setCursorFreq] = useState<number | null>(null);
  const [eq, setEq] = useState<number[]>(() => [...DEFAULT_AUDIO_SETTINGS.eq]);
  const [denoise, setDenoise] = useState(DEFAULT_AUDIO_SETTINGS.denoise);
  const [denoiseAmount, setDenoiseAmount] = useState(DEFAULT_AUDIO_SETTINGS.denoiseAmount);
  const [limiter, setLimiter] = useState(DEFAULT_AUDIO_SETTINGS.limiter);
  const [limiterThreshold, setLimiterThreshold] = useState(DEFAULT_AUDIO_SETTINGS.limiterThreshold);
  const centerRef = useRef(100_000_000);
  const sampleRateRef = useRef(2_400_000);
  const listeningRef = useRef(false);
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const audioSettingsRef = useRef<AudioSettings>({
    eq: [...DEFAULT_AUDIO_SETTINGS.eq],
    denoise: DEFAULT_AUDIO_SETTINGS.denoise,
    denoiseAmount: DEFAULT_AUDIO_SETTINGS.denoiseAmount,
    limiter: DEFAULT_AUDIO_SETTINGS.limiter,
    limiterThreshold: DEFAULT_AUDIO_SETTINGS.limiterThreshold,
  });

  const ensureAudio = () => {
    if (!audioEngineRef.current) {
      audioEngineRef.current = new AudioEngine(audioSettingsRef.current);
      audioEngineRef.current.init();
    }
    audioEngineRef.current.resume();
    return audioEngineRef.current;
  };

  useEffect(() => {
    client.connect();
    client
      .getDevice()
      .then(setStatus)
      .catch(() => {});
    let frameCount = 0;
    const fpsTimer = window.setInterval(() => {
      setStreamFps(frameCount);
      frameCount = 0;
    }, 1000);
    const u1 = client.onStatus((s) => {
      setStatus(s);
      centerRef.current = s.frequency;
      sampleRateRef.current = s.sampleRate;
      listeningRef.current = s.listening;
    });
    const u2 = client.onConnect(setWsConnected);
    const u3 = client.onSpectrum(() => frameCount++);
    const u4 = client.onBandFrame(() => frameCount++);
    const u5 = client.onAudio((data) => {
      if (!listeningRef.current) return;
      ensureAudio().push(data);
    });
    return () => {
      clearInterval(fpsTimer);
      u1();
      u2();
      u3();
      u4();
      u5();
      audioEngineRef.current?.dispose();
      audioEngineRef.current = null;
    };
  }, []);

  const handleEq = (index: number, gain: number) => {
    setEq((prev) => {
      const next = prev.map((g, i) => (i === index ? gain : g));
      audioSettingsRef.current = { ...audioSettingsRef.current, eq: next };
      audioEngineRef.current?.setEq(next);
      return next;
    });
  };

  const handleEqReset = () => {
    const next = EQ_FREQS.map(() => 0);
    setEq(next);
    audioSettingsRef.current = { ...audioSettingsRef.current, eq: next };
    audioEngineRef.current?.setEq(next);
  };

  const handleDenoise = (on: boolean) => {
    setDenoise(on);
    audioSettingsRef.current = { ...audioSettingsRef.current, denoise: on };
    audioEngineRef.current?.setDenoise(on, audioSettingsRef.current.denoiseAmount);
  };

  const handleDenoiseAmount = (amount: number) => {
    setDenoiseAmount(amount);
    audioSettingsRef.current = { ...audioSettingsRef.current, denoiseAmount: amount };
    audioEngineRef.current?.setDenoise(audioSettingsRef.current.denoise, amount);
  };

  const handleLimiter = (on: boolean) => {
    setLimiter(on);
    audioSettingsRef.current = { ...audioSettingsRef.current, limiter: on };
    audioEngineRef.current?.setLimiter(on, audioSettingsRef.current.limiterThreshold);
  };

  const handleLimiterThreshold = (db: number) => {
    setLimiterThreshold(db);
    audioSettingsRef.current = { ...audioSettingsRef.current, limiterThreshold: db };
    audioEngineRef.current?.setLimiter(audioSettingsRef.current.limiter, db);
  };

  const apply = async (p: Promise<ServerStatus>) => {
    try {
      setStatus(await p);
    } catch {
      /* backend not reachable */
    }
  };

  // режим демодуляции всегда следует за выбранным диапазоном
  useEffect(() => {
    apply(client.setMode(band.mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [band]);

  const tune = (f: number) => {
    centerRef.current = f;
    apply(client.tune({ frequency: f }));
  };

  const handleCursor = (f: number) => {
    setCursorFreq(f);
    // вне прослушивания клик только ставит курсор — приём не перестраиваем
    if (listeningRef.current) tune(f);
  };

  const handleBandChange = (b: BandPreset) => {
    if (listeningRef.current) {
      listeningRef.current = false;
      apply(client.setListen(false));
    }
    setBand(b);
    setCursorFreq(null);
  };

  const handleListen = (on: boolean) => {
    listeningRef.current = on;
    apply(client.setListen(on));
    if (on) {
      ensureAudio();
      void client.stopBand();
      const target = cursorFreq ?? Math.round((band.start + band.stop) / 2);
      tune(target);
      if (cursorFreq == null) setCursorFreq(target);
    } else {
      void client.startBand(band.start, band.stop, sweepOptions());
    }
  };

  return (
    <div className="app">
      <header>
        <h1>RTL-SDR Обсерватория</h1>
        <span className="header-status">
          {status?.connected ? (
            <span className="ok">
              {status.tunerName} ·{" "}
              {cursorFreq != null ? fmtMHz(cursorFreq) : fmtMHz(status.frequency)} МГц ·{" "}
              {status.listening ? "🔊" : ""}
            </span>
          ) : (
            <span className="warn">rtl_tcp не подключён — запустите агент в тулбаре</span>
          )}
        </span>
        <span className={`stream ${wsConnected && streamFps > 0 ? "on" : ""}`}>
          {wsConnected ? (streamFps > 0 ? `поток ${streamFps} к/с` : "WS: нет данных") : "WS: нет связи"}
        </span>
      </header>

      <main>
        <div className="left">
          <BandView
            status={status}
            band={band}
            onBandChange={handleBandChange}
            cursorFreq={cursorFreq}
            onCursor={handleCursor}
            listening={status?.listening ?? false}
            onListen={handleListen}
          />
        </div>
        <aside>
          <Scanner
            band={band}
            onHit={handleCursor}
            onFinished={() => {
              if (!listeningRef.current) void client.startBand(band.start, band.stop, sweepOptions());
            }}
          />
          <div className="receiver-panel">
            <div className="audio-title">Приём · усиление</div>
            <div className="receiver-row">
              <label className="chk">
                <input
                  type="checkbox"
                  checked={status?.agc ?? true}
                  onChange={(e) => apply(client.tune({ agc: e.target.checked, gainMode: e.target.checked ? 0 : 1 }))}
                />
                AGC
              </label>
              <span>{((status?.gain ?? 0) / 10).toFixed(1)} dB</span>
            </div>
            <input
              type="range"
              min={0}
              max={496}
              step={1}
              value={status?.gain ?? 0}
              disabled={status?.agc ?? true}
              onChange={(e) => apply(client.tune({ gain: Number(e.target.value), gainMode: 1, agc: false }))}
            />
          </div>
          <AudioPanel
            eq={eq}
            denoise={denoise}
            denoiseAmount={denoiseAmount}
            limiter={limiter}
            limiterThreshold={limiterThreshold}
            onEq={handleEq}
            onDenoise={handleDenoise}
            onDenoiseAmount={handleDenoiseAmount}
            onLimiter={handleLimiter}
            onLimiterThreshold={handleLimiterThreshold}
            onEqReset={handleEqReset}
          />
        </aside>
      </main>
    </div>
  );
}
