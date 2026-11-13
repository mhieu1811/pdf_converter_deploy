import { ConversionError, type LayoutReply, type LayoutRequest, type PageEvidence, type PageLayout, type Warning } from "./types";

type Job = { resolve: (reply: LayoutReply) => void; reject: (reason: unknown) => void };

const failure = () => new ConversionError("CONVERSION_FAILED", "Không dựng được bố cục hoặc tệp Word.");

/** Runs layout reconstruction and DOCX export in their own worker; one reply is awaited per request. */
export class LayoutClient {
  private readonly worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, Job>();
  private nextJob = 1;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<LayoutReply>) => {
      const job = this.pending.get(event.data.jobId);
      if (!job) return;
      this.pending.delete(event.data.jobId);
      if (event.data.type === "error") job.reject(failure());
      else job.resolve(event.data);
    };
    this.worker.onerror = () => this.failAll();
  }

  /** Resolves once the worker script has loaded, so later use needs no network. */
  async ready(): Promise<void> {
    await this.send({ type: "ping", jobId: this.nextJob++ });
  }

  async reconstruct(evidence: PageEvidence): Promise<{ layout: PageLayout; warnings: Warning[] }> {
    const reply = await this.send({ type: "reconstruct", jobId: this.nextJob++, evidence }, evidence.images.map((image) => image.png.buffer as ArrayBuffer));
    if (reply.type !== "reconstructed") throw failure();
    return { layout: reply.layout, warnings: reply.warnings };
  }

  async build(pages: PageLayout[]): Promise<Uint8Array> {
    const reply = await this.send({ type: "build", jobId: this.nextJob++, pages });
    if (reply.type !== "built") throw failure();
    return reply.bytes;
  }

  dispose(): void {
    this.worker.terminate();
    this.failAll();
  }

  private send(request: LayoutRequest, transfer: Transferable[] = []): Promise<LayoutReply> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.jobId, { resolve, reject });
      this.worker.postMessage(request, transfer);
    });
  }

  private failAll(): void {
    for (const job of this.pending.values()) job.reject(failure());
    this.pending.clear();
  }
}
