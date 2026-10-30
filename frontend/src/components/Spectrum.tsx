import { useEffect, useRef } from "react";
import { client } from "../lib/wsClient";

interface Props {
  centerRef: React.MutableRefObject<number>;
  sampleRateRef: React.MutableRefObject<number>;
  onTune: (freq: number) => void;
}

const DB_MIN = -110;
const DB_MAX = -10;

export function Spectrum({ centerRef, sampleRateRef, onTune }: Props) {
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
    let raf = 0;
    let data: Float32Array | null = null;
    const unsub = client.onSpectrum((d) => (data = d));

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.width;
      const h = canvas.height;

      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, w, h);

      const sr = sampleRateRef.current;
      const center = centerRef.current;
      const span = sr;

      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "10px monospace";
      ctx.lineWidth = 1;

      const gridStep = niceStep(span);
      const first = Math.ceil((center - span / 2) / gridStep) * gridStep;
      for (let f = first; f <= center + span / 2; f += gridStep) {
        const x = ((f - (center - span / 2)) / span) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillText(`${(f / 1e6).toFixed(f % 1e6 === 0 ? 0 : 1)}M`, x + 3, h - 6);
      }

      for (let db = DB_MIN; db <= DB_MAX; db += 20) {
        const y = h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillText(`${db}`, 4, y - 3);
      }

      if (!data) return;

      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w;
        const y = h - clamp((data[i] - DB_MIN) / (DB_MAX - DB_MIN)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#4db8ff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = "rgba(77,184,255,0.12)";
      ctx.fill();

      const cx = ((center - (center - span / 2)) / span) * w;
      ctx.strokeStyle = "rgba(255, 210, 74, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 210, 74, 0.95)";
      ctx.fillText(`${(center / 1e6).toFixed(1)} МГц`, cx + 5, 14);
    };

    draw();
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [centerRef, sampleRateRef]);

  return <canvas ref={canvasRef} className="spectrum" width={1000} height={250} onClick={handleClick} />;
}

function niceStep(span: number): number {
  const target = span / 10;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= target) return m * mag;
  }
  return 10 * mag;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
