import { useEffect, useRef } from "react";
import { client } from "../lib/wsClient";

const DB_MIN = -110;
const DB_MAX = -10;

interface Props {
  centerRef: React.MutableRefObject<number>;
  sampleRateRef: React.MutableRefObject<number>;
  onTune: (freq: number) => void;
}

const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const r = clamp(1.5 - Math.abs(4 * t - 3));
    const g = clamp(1.5 - Math.abs(4 * t - 2));
    const b = clamp(1.5 - Math.abs(4 * t - 1));
    lut[i * 4] = r * 255;
    lut[i * 4 + 1] = g * 255;
    lut[i * 4 + 2] = b * 255;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

export function Waterfall({ centerRef, sampleRateRef, onTune }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const freq = centerRef.current + (frac - 0.5) * sampleRateRef.current;
    onTune(Math.round(freq));
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    const row = new ImageData(w, 1);
    let raf = 0;
    let pending: Float32Array | null = null;

    const unsub = client.onSpectrum((d) => {
      if (pending === null) {
        raf = requestAnimationFrame(render);
      }
      pending = d;
    });

    const render = () => {
      if (pending) {
        const d = pending;
        const pix = row.data;
        for (let i = 0; i < w; i++) {
          const src = Math.floor((i / w) * d.length);
          const t = clamp((d[src] - DB_MIN) / (DB_MAX - DB_MIN));
          const idx = Math.floor(t * 255) * 4;
          const o = i * 4;
          pix[o] = LUT[idx];
          pix[o + 1] = LUT[idx + 1];
          pix[o + 2] = LUT[idx + 2];
          pix[o + 3] = 255;
        }
        ctx.drawImage(canvas, 0, -1);
        ctx.putImageData(row, 0, h - 1);
        pending = null;
      }
      drawMarker();
      raf = 0;
    };

    const drawMarker = () => {
      const cx = w / 2;
      ctx.strokeStyle = "rgba(255, 210, 74, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 210, 74, 0.95)";
      ctx.font = "11px monospace";
      ctx.fillText(`${(centerRef.current / 1e6).toFixed(1)} МГц`, cx + 5, 12);
    };

    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [centerRef]);

  return <canvas ref={canvasRef} className="waterfall" width={1000} height={300} onClick={handleClick} />;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
