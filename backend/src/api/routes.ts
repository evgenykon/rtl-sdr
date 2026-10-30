import type { FastifyInstance } from "fastify";
import type { DeviceManager } from "../device/deviceManager.js";
import type { DemodMode } from "../dsp/demod.js";

interface TuneBody {
  frequency?: number;
  sampleRate?: number;
  gainMode?: 0 | 1;
  gain?: number;
  agc?: boolean;
}

interface ModeBody {
  mode: DemodMode;
}

interface ListenBody {
  on: boolean;
}

interface ScanBody {
  start: number;
  stop: number;
  threshold?: number;
  minSnr?: number;
}

export function registerRoutes(app: FastifyInstance, manager: DeviceManager): void {
  app.get("/api/device", async () => manager.getStatus());

  app.post("/api/tune", async (req, reply) => {
    const body = (req.body ?? {}) as TuneBody;
    if (typeof body.frequency === "number") manager.tune(body.frequency);
    if (typeof body.sampleRate === "number") manager.setSampleRate(body.sampleRate);
    if (typeof body.gainMode === "number") manager.setGainMode(body.gainMode);
    if (typeof body.gain === "number") manager.setGain(body.gain);
    if (typeof body.agc === "boolean") manager.setAgc(body.agc);
    return manager.getStatus();
  });

  app.post("/api/mode", async (req) => {
    const body = req.body as ModeBody;
    manager.setAudioMode(body.mode);
    return manager.getStatus();
  });

  app.post("/api/listen", async (req) => {
    const body = req.body as ListenBody;
    manager.setListening(body.on);
    return manager.getStatus();
  });

  app.post("/api/scan", async (req, reply) => {
    const body = req.body as ScanBody;
    if (typeof body.start !== "number" || typeof body.stop !== "number") {
      return reply.code(400).send({ error: "start and stop required" });
    }
    const results = await manager.startScan({
      startHz: body.start,
      stopHz: body.stop,
      thresholdDb: typeof body.threshold === "number" ? body.threshold : -110,
      minSnrDb: typeof body.minSnr === "number" ? body.minSnr : 8,
    });
    return { results };
  });

  app.post("/api/scan/cancel", async () => {
    manager.cancelScan();
    return { ok: true };
  });

  app.get("/api/scan", async () => manager.getLastScan());

  app.post("/api/band", async (req, reply) => {
    const body = req.body as ScanBody;
    if (typeof body.start !== "number" || typeof body.stop !== "number") {
      return reply.code(400).send({ error: "start and stop required" });
    }
    manager.startBandSweep(body.start, body.stop).catch((e: Error) => {
      manager.broadcastError(e.message);
    });
    return { ok: true };
  });

  app.post("/api/band/stop", async () => {
    manager.stopBandSweep();
    return { ok: true };
  });
}
