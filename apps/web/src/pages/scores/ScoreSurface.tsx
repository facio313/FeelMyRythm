import { Button } from '@feelmyrythm/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LocalScore } from '../../lib/localDb';
import { renderMusicXml } from '../../lib/musicxml';

function useObjectUrl(blob?: Blob) {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

function PdfPage({
  blob,
  pageNumber,
  onPageCount,
}: {
  blob: Blob;
  pageNumber: number;
  onPageCount: (count: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState<string>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let destroyLoadingTask: (() => Promise<void>) | undefined;
    void (async () => {
      try {
        const data = await blob.arrayBuffer();
        if (cancelled) return;
        const [{ GlobalWorkerOptions, getDocument }, pdfWorker] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        if (cancelled) return;
        GlobalWorkerOptions.workerSrc = pdfWorker.default;
        const loadingTask = getDocument({ data });
        destroyLoadingTask = () => loadingTask.destroy();
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        onPageCount(pdf.numPages);
        const page = await pdf.getPage(Math.min(pageNumber, pdf.numPages));
        const base = page.getViewport({ scale: 1 });
        const width = canvas.parentElement?.clientWidth ?? 800;
        const viewport = page.getViewport({ scale: Math.min(2.5, width / base.width) });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(viewport.width * ratio);
        canvas.height = Math.round(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!cancelled) setRenderError(undefined);
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : 'PDF를 렌더링하지 못했습니다.');
        }
      }
    })();
    return () => {
      cancelled = true;
      void destroyLoadingTask?.();
    };
  }, [blob, onPageCount, pageNumber, renderAttempt]);
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

function MusicXmlPage({ blob }: { blob: Blob }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void blob
      .text()
      .then(async (xml) => {
        if (!cancelled && containerRef.current) await renderMusicXml(containerRef.current, xml);
        if (!cancelled) setRenderError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRenderError(
            error instanceof Error ? error.message : 'MusicXML을 렌더링하지 못했습니다.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [blob, renderAttempt]);
  return (
    <>
      {renderError ? (
        <div className="score-render-error" role="alert">
          <strong>MusicXML 악보를 표시하지 못했습니다.</strong>
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
      <div ref={containerRef} className="musicxml-sheet" hidden={Boolean(renderError)} />
    </>
  );
}

export function ScoreSurface({
  score,
  page,
  onPageCount,
}: {
  score: LocalScore;
  page: number;
  onPageCount: (count: number) => void;
}) {
  const imageUrl = useObjectUrl(score.mimeType.startsWith('image/') ? score.blob : undefined);
  if (score.mimeType === 'application/pdf') {
    return <PdfPage blob={score.blob} pageNumber={page} onPageCount={onPageCount} />;
  }
  if (score.mimeType.includes('musicxml') || score.name.endsWith('.musicxml')) {
    return <MusicXmlPage blob={score.blob} />;
  }
  if (imageUrl) {
    return <img className="score-image" src={imageUrl} alt={score.name} draggable={false} />;
  }
  return <div className="unsupported-score">이 악보 형식은 미리보기를 지원하지 않습니다.</div>;
}
