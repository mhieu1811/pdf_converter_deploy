import { buildDocx } from "./docx";
import { reconstructPage } from "./layout";
import type { LayoutReply, LayoutRequest } from "./types";

// Layout reconstruction and DOCX export are CPU-heavy, so they stay off the UI thread.
self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const request = event.data;
  try {
    if (request.type === "ping") {
      self.postMessage({ type: "pong", jobId: request.jobId } satisfies LayoutReply);
    } else if (request.type === "reconstruct") {
      const { layout, warnings } = reconstructPage(request.evidence);
      self.postMessage({ type: "reconstructed", jobId: request.jobId, layout, warnings } satisfies LayoutReply);
    } else if (request.type === "build") {
      const bytes = await buildDocx(request.pages);
      self.postMessage({ type: "built", jobId: request.jobId, bytes } satisfies LayoutReply, { transfer: [bytes.buffer] });
    } else {
      throw new Error("Unknown layout request");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Layout failed";
    self.postMessage({ type: "error", jobId: (request as { jobId: number }).jobId, message } satisfies LayoutReply);
  }
};
