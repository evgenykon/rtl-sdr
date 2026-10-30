export interface ServerStatus {
  connected: boolean;
  tunerName: string;
  gainCount: number;
  sampleRate: number;
  frequency: number;
  gainMode: 0 | 1;
  gain: number;
  agc: boolean;
  directSampling: number;
  biasTee: boolean;
  listening: boolean;
  audioMode: string;
  scanning: boolean;
  scanResults: number;
}

export interface ScanProgress {
  center: number;
  index: number;
  total: number;
}

export interface ScanHit {
  frequency: number;
  powerDb: number;
  bandwidthHz: number;
}

export interface BandMeta {
  start: number;
  stop: number;
  binWidth: number;
  binCount: number;
  complete?: boolean;
}

type Unsub = () => void;

export class SdrClient {
  private ws: WebSocket | null = null;
  private spectrumCbs: ((data: Float32Array<ArrayBuffer>) => void)[] = [];
  private audioCbs: ((data: Float32Array<ArrayBuffer>) => void)[] = [];
  private statusCbs: ((s: ServerStatus) => void)[] = [];
  private progressCbs: ((p: ScanProgress) => void)[] = [];
  private resultCbs: ((r: ScanHit[]) => void)[] = [];
  private errorCbs: ((msg: string) => void)[] = [];
  private connCbs: ((connected: boolean) => void)[] = [];
  private bandStartCbs: ((meta: BandMeta) => void)[] = [];
  private bandFrameCbs: ((data: Float32Array<ArrayBuffer>) => void)[] = [];

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.connCbs.forEach((cb) => cb(true));
    ws.onmessage = (ev) => this.handleMessage(ev);
    ws.onclose = () => {
      this.connCbs.forEach((cb) => cb(false));
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  private async handleMessage(ev: MessageEvent): Promise<void> {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "status") this.statusCbs.forEach((cb) => cb(msg));
      else if (msg.type === "scan-progress") this.progressCbs.forEach((cb) => cb(msg));
      else if (msg.type === "scan-result") this.resultCbs.forEach((cb) => cb(msg.results));
      else if (msg.type === "error") this.errorCbs.forEach((cb) => cb(msg.message));
      else if (msg.type === "band-start") this.bandStartCbs.forEach((cb) => cb(msg));
      return;
    }
    const buf = await ev.data.arrayBuffer();
    const view = new DataView(buf);
    const type = view.getUint8(0);
    const len = view.getUint32(4, true);
    const data = new Float32Array(buf, 8, len);
    if (type === 0x01) this.spectrumCbs.forEach((cb) => cb(data));
    else if (type === 0x02) this.audioCbs.forEach((cb) => cb(data));
    else if (type === 0x03) this.bandFrameCbs.forEach((cb) => cb(data));
  }

  onSpectrum(cb: (data: Float32Array<ArrayBuffer>) => void): Unsub {
    this.spectrumCbs.push(cb);
    return () => (this.spectrumCbs = this.spectrumCbs.filter((c) => c !== cb));
  }

  onAudio(cb: (data: Float32Array<ArrayBuffer>) => void): Unsub {
    this.audioCbs.push(cb);
    return () => (this.audioCbs = this.audioCbs.filter((c) => c !== cb));
  }

  onStatus(cb: (s: ServerStatus) => void): Unsub {
    this.statusCbs.push(cb);
    return () => (this.statusCbs = this.statusCbs.filter((c) => c !== cb));
  }

  onScanProgress(cb: (p: ScanProgress) => void): Unsub {
    this.progressCbs.push(cb);
    return () => (this.progressCbs = this.progressCbs.filter((c) => c !== cb));
  }

  onScanResult(cb: (r: ScanHit[]) => void): Unsub {
    this.resultCbs.push(cb);
    return () => (this.resultCbs = this.resultCbs.filter((c) => c !== cb));
  }

  onError(cb: (msg: string) => void): Unsub {
    this.errorCbs.push(cb);
    return () => (this.errorCbs = this.errorCbs.filter((c) => c !== cb));
  }

  onConnect(cb: (connected: boolean) => void): Unsub {
    this.connCbs.push(cb);
    return () => (this.connCbs = this.connCbs.filter((c) => c !== cb));
  }

  onBandStart(cb: (meta: BandMeta) => void): Unsub {
    this.bandStartCbs.push(cb);
    return () => (this.bandStartCbs = this.bandStartCbs.filter((c) => c !== cb));
  }

  onBandFrame(cb: (data: Float32Array<ArrayBuffer>) => void): Unsub {
    this.bandFrameCbs.push(cb);
    return () => (this.bandFrameCbs = this.bandFrameCbs.filter((c) => c !== cb));
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async tune(body: {
    frequency?: number;
    sampleRate?: number;
    gainMode?: 0 | 1;
    gain?: number;
    agc?: boolean;
  }): Promise<ServerStatus> {
    return this.api("/api/tune", body);
  }

  async setMode(mode: string): Promise<ServerStatus> {
    return this.api("/api/mode", { mode });
  }

  async setListen(on: boolean): Promise<ServerStatus> {
    return this.api("/api/listen", { on });
  }

  async startScan(start: number, stop: number, threshold: number, minSnr = 8): Promise<unknown> {
    return this.api("/api/scan", { start, stop, threshold, minSnr });
  }

  async cancelScan(): Promise<unknown> {
    return this.api("/api/scan/cancel", {});
  }

  async startBand(
    start: number,
    stop: number,
    options?: { settleMs?: number; frames?: number },
  ): Promise<unknown> {
    return this.api("/api/band", { start, stop, ...options });
  }

  async stopBand(): Promise<unknown> {
    return this.api("/api/band/stop", {});
  }

  async getDevice(): Promise<ServerStatus> {
    return this.api("/api/device", null, "GET");
  }

  private async api(path: string, body: unknown, method = "POST"): Promise<any> {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }
}

export const client = new SdrClient();
