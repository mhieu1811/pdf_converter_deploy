import { useEffect, useRef, useState, type DragEvent } from "react";
import { convertPdf, initializeEngines, inspectPdf, type EngineSession } from "./converter/convert";
import { docxFileName } from "./converter/docx";
import { ConversionError, type Progress } from "./converter/types";
import { groupWarnings, missingFeatures } from "./ui";

type Engine = { state: "unsupported"; missing: string[] } | { state: "loading" } | { state: "ready" } | { state: "failed"; message: string };

type Job =
  | { kind: "none" }
  | { kind: "validating" }
  | { kind: "selected"; file: File; pageCount: number; previewUrl?: string }
  | { kind: "working"; file: File; previewUrl?: string; progress?: Progress }
  | { kind: "completed"; file: File; previewUrl?: string; downloadUrl: string; fileName: string; warnings: { message: string; pages: number[] }[] }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string; previewUrl?: string };

const PHASE_TEXT: Record<Progress["phase"], string> = {
  validating: "Đang kiểm tra tệp",
  analyzing: "Đang phân tích trang",
  extracting: "Đang đọc chữ trong PDF, trang",
  ocr: "Đang nhận dạng chữ (OCR), trang",
  building: "Đang tạo tệp Word",
};

const progressText = (progress: Progress | undefined) =>
  progress ? `${PHASE_TEXT[progress.phase]}${progress.page ? ` ${progress.page}/${progress.totalPages}` : ""}…` : "Đang xử lý…";

const READY_TEXT = "Sẵn sàng. Chọn một tệp PDF.";

// Messages come from the converter and never contain document content.
const errorText = (error: unknown) => (error instanceof ConversionError ? error.message : "Chuyển đổi không thành công. Hãy thử lại hoặc dùng tệp khác.");

function statusText(engine: Engine, job: Job): string {
  if (engine.state === "failed") return `${engine.message} Kiểm tra kết nối rồi bấm “Thử lại”.`;
  if (engine.state === "loading") {
    if (job.kind === "cancelled") return "Đã hủy. Đang khởi tạo lại bộ xử lý…";
    if (job.kind === "failed") return `${job.message} Đang khởi tạo lại bộ xử lý…`;
    return "Đang tải bộ xử lý…";
  }
  switch (job.kind) {
    case "none":
      return READY_TEXT;
    case "validating":
      return "Đang kiểm tra tệp…";
    case "selected":
      return `Đã chọn ${job.file.name} (${job.pageCount} trang). Bấm “Chuyển sang Word” để bắt đầu.`;
    case "working":
      return progressText(job.progress);
    case "completed":
      return "Hoàn tất.";
    case "cancelled":
      return "Đã hủy. Chọn một tệp PDF để tiếp tục.";
    case "failed":
      return job.message;
  }
  return "";
}

export function App() {
  const [engine, setEngine] = useState<Engine>(() => {
    const missing = missingFeatures(window as unknown as Record<string, unknown>);
    return missing.length ? { state: "unsupported", missing } : { state: "loading" };
  });
  const [job, setJob] = useState<Job>({ kind: "none" });
  const [ocrAll, setOcrAll] = useState(false);
  const [dragging, setDragging] = useState(false);

  const engines = useRef<EngineSession | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0); // engine start
  const jobId = useRef(0); // current file/conversion; older ones are ignored
  const urls = useRef<string[]>([]);

  const makeUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    return url;
  };
  const revokeUrls = () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
  };

  const startEngines = () => {
    const mine = ++generation.current;
    setEngine({ state: "loading" });
    initializeEngines().then(
      (session) => {
        if (mine !== generation.current) {
          void session.dispose();
          return;
        }
        engines.current = session;
        setEngine({ state: "ready" });
      },
      (error) => {
        if (mine === generation.current) setEngine({ state: "failed", message: error instanceof ConversionError ? error.message : "Không khởi tạo được bộ xử lý." });
      },
    );
  };

  // A cancelled or failed job leaves no trusted engine behind: it is disposed and replaced.
  const replaceEngines = () => {
    const old = engines.current;
    engines.current = undefined;
    void old?.dispose().catch(() => undefined);
    startEngines();
  };

  useEffect(() => {
    if (engine.state !== "unsupported") startEngines();
    return () => {
      generation.current++;
      jobId.current++;
      controller.current?.abort();
      revokeUrls();
      void engines.current?.dispose().catch(() => undefined);
      engines.current = undefined;
    };
    // Runs once per mount; later restarts are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const idle = engine.state === "ready" && job.kind !== "validating" && job.kind !== "working";

  const chooseFile = async (file: File | undefined) => {
    const session = engines.current;
    if (!file || !session || !idle) return;
    const mine = ++jobId.current;
    revokeUrls();
    setOcrAll(false);
    setJob({ kind: "validating" });
    try {
      const { pageCount, preview } = await inspectPdf(file, session);
      if (mine !== jobId.current) return;
      setJob({ kind: "selected", file, pageCount, previewUrl: preview ? makeUrl(preview) : undefined });
    } catch (error) {
      if (mine === jobId.current) setJob({ kind: "failed", message: errorText(error) });
    }
  };

  const convert = async () => {
    const session = engines.current;
    if (!session || job.kind !== "selected") return;
    const { file, previewUrl } = job;
    const mine = ++jobId.current;
    const abort = new AbortController();
    controller.current = abort;
    setJob({ kind: "working", file, previewUrl });
    try {
      const result = await convertPdf(
        file,
        {
          forceOcr: ocrAll,
          signal: abort.signal,
          onProgress: (progress) => {
            if (mine === jobId.current) setJob({ kind: "working", file, previewUrl, progress });
          },
        },
        session,
      );
      if (mine !== jobId.current) return;
      setJob({ kind: "completed", file, previewUrl, downloadUrl: makeUrl(result.blob), fileName: docxFileName(file.name), warnings: groupWarnings(result.warnings) });
    } catch (error) {
      if (mine !== jobId.current) return;
      setJob({ kind: "failed", message: errorText(error), previewUrl });
      replaceEngines();
    }
  };

  const cancel = () => {
    if (job.kind !== "working") return;
    jobId.current++; // nothing more from this job may reach the screen
    controller.current?.abort();
    revokeUrls();
    setJob({ kind: "cancelled" });
    replaceEngines();
  };

  const reset = () => {
    jobId.current++;
    revokeUrls();
    setOcrAll(false);
    setJob({ kind: "none" });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void chooseFile(event.dataTransfer.files[0]);
  };

  const previewUrl = "previewUrl" in job ? job.previewUrl : undefined;
  const canReset = job.kind === "selected" || job.kind === "completed" || job.kind === "failed" || job.kind === "cancelled";

  return (
    <main>
      <h1>PDF sang Word</h1>
      <p>
        Tài liệu được xử lý ngay trên trình duyệt của bạn và không được tải lên máy chủ. Trang web này vẫn tải mã chương trình và dữ liệu nhận dạng chữ từ máy chủ lưu trữ khi mở,
        nên bên lưu trữ vẫn thấy lượt truy cập trang (địa chỉ IP, loại trình duyệt), nhưng không thấy tệp của bạn.
      </p>
      <p>Tối đa 10 MiB và 20 trang.</p>
      <p>Với bản quét (ảnh), chữ được nhận dạng tự động nên có thể sai sót; hãy đối chiếu kết quả với bản gốc.</p>

      {engine.state === "unsupported" && (
        <div role="alert" className="notice">
          Trình duyệt này chưa được hỗ trợ (thiếu: {engine.missing.join(", ")}). Hãy dùng Chrome hoặc Edge bản mới trên máy tính.
        </div>
      )}

      <div
        data-testid="dropzone"
        className={dragging ? "dropzone dragging" : "dropzone"}
        onDragOver={(event) => {
          event.preventDefault();
          if (idle) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label className="file-button">
          Chọn tệp PDF
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={!idle}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void chooseFile(file);
            }}
          />
        </label>
        <span>hoặc kéo thả tệp vào đây</span>
      </div>

      <p role="status" className="status">
        {statusText(engine, job)}
      </p>

      {engine.state === "failed" && (
        <button type="button" onClick={startEngines}>
          Thử lại
        </button>
      )}

      {previewUrl && <img className="preview" src={previewUrl} alt="Xem trước trang 1 của tệp PDF đã chọn" />}

      {job.kind === "selected" && (
        <>
          <label className="check">
            <input type="checkbox" checked={ocrAll} onChange={(event) => setOcrAll(event.target.checked)} /> OCR tất cả các trang (dùng khi chữ có sẵn trong PDF bị sai hoặc lệch)
          </label>
          <button type="button" className="primary" onClick={() => void convert()}>
            Chuyển sang Word
          </button>
        </>
      )}

      {job.kind === "working" && (
        <button type="button" onClick={cancel}>
          Hủy
        </button>
      )}

      {job.kind === "completed" && (
        <>
          <a className="primary" href={job.downloadUrl} download={job.fileName}>
            Tải {job.fileName}
          </a>
          {job.warnings.length > 0 && (
            <>
              <h2>Cảnh báo chất lượng</h2>
              <ul aria-label="Cảnh báo chất lượng">
                {job.warnings.map((warning) => (
                  <li key={warning.message}>
                    Trang {warning.pages.join(", ")}: {warning.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {canReset && (
        <>
          <button type="button" onClick={reset}>
            Chọn tệp khác
          </button>
          {job.kind === "completed" && <p className="hint">Chọn tệp khác chỉ xóa dữ liệu đang giữ trong trình duyệt; tệp Word đã tải về vẫn còn trên máy của bạn.</p>}
        </>
      )}
    </main>
  );
}
