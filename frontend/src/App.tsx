import { useEffect, useRef, useState } from "react";
import { client, type ServerStatus } from "./lib/wsClient";
import { BANDS, type BandPreset } from "./lib/bands";
import { BandView } from "./components/BandView";
import { Scanner } from "./components/Scanner";
import { fmtMHz } from "./lib/bands";

export default function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [streamFps, setStreamFps] = useState(0);
  const [band, setBand] = useState<BandPreset>(BANDS[0]);
  const [cursorFreq, setCursorFreq] = useState<number | null>(null);
  const centerRef = useRef(100_000_000);
  const sampleRateRef = useRef(2_400_000);
  const listeningRef = useRef(false);
  const audioRef = useRef<{ ctx: AudioContext | null; next: number }>({ ctx: null, next: 0 });

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
      const st = audioRef.current;
      if (!st.ctx) st.ctx = new AudioContext({ sampleRate: 48000 });
      const ctx = st.ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const buf = ctx.createBuffer(1, data.length, 48000);
      buf.copyToChannel(data, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      if (st.next < now + 0.02) st.next = now + 0.05;
      src.start(st.next);
      st.next += buf.duration;
    });
    return () => {
      clearInterval(fpsTimer);
      u1();
      u2();
      u3();
      u4();
      u5();
    };
  }, []);

  const apply = async (p: Promise<ServerStatus>) => {
    try {
      setStatus(await p);
    } catch {
      /* backend not reachable */
    }
  };

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
    apply(client.setMode(b.mode));
  };

  const handleListen = (on: boolean) => {
    listeningRef.current = on;
    apply(client.setListen(on));
    if (on) {
      void client.stopBand();
      const target = cursorFreq ?? Math.round((band.start + band.stop) / 2);
      tune(target);
      if (cursorFreq == null) setCursorFreq(target);
    } else {
      void client.startBand(band.start, band.stop);
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
          <div className="hint">
            Клик по водопаду — только ставит курсор (приём не трогаем). «Слушать» — настройка на курсор и звук;
            свип полосы встаёт на паузу (один приёмник), водопад остаётся как есть. Во время прослушивания
            клик перестраивает приём.
          </div>
          <BandView
            status={status}
            band={band}
            onBandChange={handleBandChange}
            cursorFreq={cursorFreq}
            onCursor={handleCursor}
            listening={status?.listening ?? false}
            onListen={handleListen}
            onMode={(m) => apply(client.setMode(m))}
            onAgc={(on) => apply(client.tune({ agc: on, gainMode: on ? 0 : 1 }))}
            onGain={(g) => apply(client.tune({ gain: g, gainMode: 1, agc: false }))}
          />
        </div>
        <aside>
          <Scanner
            onHit={handleCursor}
            onFinished={() => {
              if (!listeningRef.current) void client.startBand(band.start, band.stop);
            }}
          />
        </aside>
      </main>
    </div>
  );
}
