import { Button } from '@feelmyrythm/ui';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';

export function PdfPage({
  blob,
  pageNumber,
  onPageCount,
}: {
  blob: Blob;
  pageNumber: number;
  onPageCount: (count: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<{
    blob: Blob;
    attempt: number;
    pdf: PDFDocumentProxy;
  }>();
  const [renderError, setRenderError] = useState<string>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [sizeRevision, setSizeRevision] = useState(0);
  const pdf = document?.blob === blob && document.attempt === renderAttempt ? document.pdf : null;

  // The document owns its worker. Page changes and layout changes only render a
  // page; they must not reread/transfer the entire Blob or create another worker.
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    void (async () => {
      try {
        const [data, { GlobalWorkerOptions, getDocument }, pdfWorker] = await Promise.all([
          blob.arrayBuffer(),
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        if (cancelled) return;
        GlobalWorkerOptions.workerSrc = pdfWorker.default;
        const task = getDocument({ data });
        destroy = () => task.destroy();
        const loaded = await task.promise;
        if (!cancelled) {
          setRenderError(undefined);
          setDocument({ blob, attempt: renderAttempt, pdf: loaded });
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : 'PDF를 불러오지 못했습니다.');
        }
      }
    })();
    return () => {
      cancelled = true;
      void destroy?.().catch((error: unknown) => console.error('PDF cleanup failed', error));
    };
  }, [blob, renderAttempt]);

  useEffect(() => {
    if (pdf) onPageCount(pdf.numPages);
  }, [pdf, onPageCount]);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return;
    let width = parent.clientWidth;
    let ratio = window.devicePixelRatio || 1;
    const resize = () => {
      const nextWidth = parent.clientWidth;
      const nextRatio = window.devicePixelRatio || 1;
      if (nextWidth === width && nextRatio === ratio) return;
      width = nextWidth;
      ratio = nextRatio;
      setSizeRevision((revision) => revision + 1);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdf) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    void (async () => {
      try {
        const page = await pdf.getPage(Math.max(1, Math.min(pageNumber, pdf.numPages)));
        try {
          if (cancelled) return;
          const width = canvas.parentElement?.clientWidth ?? 0;
          if (width <= 0) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2.5, width / base.width) });
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.round(viewport.width * ratio);
          canvas.height = Math.round(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('PDF canvas를 준비하지 못했습니다.');
          task = page.render({
            canvas,
            canvasContext: context,
            viewport,
            transform: [ratio, 0, 0, ratio, 0, 0],
          });
          await task.promise;
          if (!cancelled) setRenderError(undefined);
        } finally {
          // Keep the document, but release page graphics after rendering/cancel.
          page.cleanup();
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : 'PDF를 렌더링하지 못했습니다.');
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, sizeRevision]);

  return (
    <>
      {renderError ? (
        <div className="score-render-error" role="alert">
          <strong>PDF 페이지를 표시하지 못했습니다.</strong>
          <span>{renderError}</span>
          <Button
            onClick={() => {
              setRenderError(undefined);
              setRenderAttempt((current) => current + 1);
            }}
          >
            다시 시도
          </Button>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className="score-canvas"
        aria-label={`PDF ${pageNumber}페이지`}
        hidden={Boolean(renderError)}
      />
    </>
  );
}
