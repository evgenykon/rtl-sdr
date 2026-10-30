import net from "node:net";
import fs from "node:fs";
import { config } from "../config.js";

const CMD = {
  SET_FREQUENCY: 0x01,
  SET_SAMPLE_RATE: 0x02,
  SET_GAIN_MODE: 0x03,
  SET_GAIN: 0x04,
  SET_FREQ_CORRECTION: 0x05,
  SET_AGC_MODE: 0x06,
  SET_DIRECT_SAMPLING: 0x07,
  SET_OFFSET_TUNING: 0x08,
  SET_BIAS_TEE: 0x09,
  SET_GAIN_BY_INDEX: 0x0a,
} as const;

export interface RtlTcpInfo {
  tunerType: number;
  gainCount: number;
}

export interface RtlTcpCallbacks {
  onStatus: (connected: boolean, info?: RtlTcpInfo) => void;
  onSamples: (iq: Float32Array) => void;
  onError: (error: Error) => void;
}

const TUNER_NAMES: Record<number, string> = {
  0: "UNKNOWN",
  1: "E4000",
  2: "FC0012",
  3: "FC0013",
  4: "FC2580",
  5: "R820T",
  6: "R828D",
};

export class RtlTcpClient {
  private socket: net.Socket | null = null;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private connected = false;
  private info: RtlTcpInfo = { tunerType: 0, gainCount: 0 };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private noDataTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private stalledRestartRequested = false;

  private sampleRate = config.defaultSampleRate;
  private frequency = 100_000_000;
  private gainMode = 0;
  private gain = 0;
  private agc = false;
  private directSampling = 0;
  private biasTee = false;

  constructor(private callbacks: RtlTcpCallbacks) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get deviceInfo(): RtlTcpInfo {
    return this.info;
  }

  get tunerName(): string {
    return TUNER_NAMES[this.info.tunerType] ?? `TUNER_${this.info.tunerType}`;
  }

  get currentSampleRate(): number {
    return this.sampleRate;
  }

  get currentFrequency(): number {
    return this.frequency;
  }

  get gainModeValue(): 0 | 1 {
    return this.gainMode === 1 ? 1 : 0;
  }

  get gainValue(): number {
    return this.gain;
  }

  get agcEnabled(): boolean {
    return this.agc;
  }

  get directSamplingValue(): number {
    return this.directSampling;
  }

  get biasTeeEnabled(): boolean {
    return this.biasTee;
  }

  connect(): void {
    if (this.disposed) return;
    const socket = net.createConnection({ host: config.rtlTcpHost, port: config.rtlTcpPort });
    this.socket = socket;

    socket.on("connect", () => {
      this.buffer = Buffer.alloc(0);
      this.armNoDataWatchdog();
    });

    socket.on("data", (chunk) => this.handleData(chunk));

    socket.on("error", (err) => {
      this.callbacks.onError(err);
      this.drop();
    });

    socket.on("close", () => this.drop());
  }

  private armNoDataWatchdog(): void {
    this.clearNoDataWatchdog();
    this.noDataTimer = setTimeout(() => this.onNoData(), config.noDataTimeoutMs);
  }

  private clearNoDataWatchdog(): void {
    if (this.noDataTimer) {
      clearTimeout(this.noDataTimer);
      this.noDataTimer = null;
    }
  }

  private onNoData(): void {
    this.noDataTimer = null;
    this.callbacks.onError(new Error("rtl_tcp не отдаёт данные — перезапускаю rtl_tcp"));
    if (!this.stalledRestartRequested) {
      this.stalledRestartRequested = true;
      void this.requestAgentRestart().finally(() => {
        setTimeout(() => (this.stalledRestartRequested = false), 5000);
      });
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.callbacks.onStatus(false);
    this.scheduleReconnect();
  }

  /** Просим агент в тулбаре перезапустить rtl_tcp (лечит «зомби»-соединение). */
  private async requestAgentRestart(): Promise<void> {
    try {
      let token = "";
      if (config.agentTokenFile) {
        try {
          token = fs.readFileSync(config.agentTokenFile, "utf8").trim();
        } catch {
          token = "";
        }
      }
      if (!token) return;
      await fetch(`${config.agentUrl}/rtl/restart?token=${encodeURIComponent(token)}`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // агент недоступен — ничего страшного, попробуем в следующий раз
    }
  }

  private drop(): void {
    this.clearNoDataWatchdog();
    if (!this.connected) {
      this.scheduleReconnect();
      return;
    }
    this.connected = false;
    this.callbacks.onStatus(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    if (!this.connected) {
      if (this.buffer.length < 16) return;
      const magic = this.buffer.subarray(0, 4).toString("ascii");
      if (magic !== "RTL0") {
        this.callbacks.onError(new Error(`Bad rtl_tcp magic: ${magic}`));
        this.buffer = this.buffer.subarray(4);
        return;
      }
      const tunerType = this.buffer.readUInt32BE(4);
      const gainCount = this.buffer.readUInt32BE(8);
      this.info = { tunerType, gainCount };
      this.buffer = this.buffer.subarray(16);
      this.connected = true;
      this.clearNoDataWatchdog();
      this.callbacks.onStatus(true, this.info);
      this.reapplySettings();
    }

    const samples = Math.floor(this.buffer.length / 2);
    if (samples === 0) return;

    const iq = new Float32Array(samples * 2);
    for (let i = 0; i < samples; i++) {
      iq[i * 2] = (this.buffer[i * 2] - 127.5) / 127.5;
      iq[i * 2 + 1] = (this.buffer[i * 2 + 1] - 127.5) / 127.5;
    }
    this.buffer = this.buffer.subarray(samples * 2);
    this.callbacks.onSamples(iq);
  }

  private reapplySettings(): void {
    this.sendCommand(CMD.SET_SAMPLE_RATE, this.sampleRate);
    this.sendCommand(CMD.SET_FREQUENCY, this.frequency);
    this.sendCommand(CMD.SET_GAIN_MODE, this.gainMode);
    if (this.gainMode === 1) this.sendCommand(CMD.SET_GAIN, this.gain);
    this.sendCommand(CMD.SET_AGC_MODE, this.agc ? 1 : 0);
    this.sendCommand(CMD.SET_DIRECT_SAMPLING, this.directSampling);
    this.sendCommand(CMD.SET_BIAS_TEE, this.biasTee ? 1 : 0);
  }

  private sendCommand(cmd: number, param: number): void {
    if (!this.socket || !this.connected) return;
    const buf = Buffer.alloc(5);
    buf.writeUInt8(cmd, 0);
    buf.writeUInt32BE(param >>> 0, 1);
    this.socket.write(buf);
  }

  setFrequency(hz: number): void {
    this.frequency = hz;
    this.sendCommand(CMD.SET_FREQUENCY, hz);
  }

  setSampleRate(hz: number): void {
    this.sampleRate = hz;
    this.sendCommand(CMD.SET_SAMPLE_RATE, hz);
  }

  setGainMode(mode: 0 | 1): void {
    this.gainMode = mode;
    this.sendCommand(CMD.SET_GAIN_MODE, mode);
  }

  setGain(tenthsDb: number): void {
    this.gain = tenthsDb;
    if (this.gainMode === 1) this.sendCommand(CMD.SET_GAIN, tenthsDb);
  }

  setAgc(enabled: boolean): void {
    this.agc = enabled;
    this.sendCommand(CMD.SET_AGC_MODE, enabled ? 1 : 0);
  }

  setDirectSampling(mode: number): void {
    this.directSampling = mode;
    this.sendCommand(CMD.SET_DIRECT_SAMPLING, mode);
  }

  setBiasTee(enabled: boolean): void {
    this.biasTee = enabled;
    this.sendCommand(CMD.SET_BIAS_TEE, enabled ? 1 : 0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearNoDataWatchdog();
    this.socket?.destroy();
    this.socket = null;
  }
}
