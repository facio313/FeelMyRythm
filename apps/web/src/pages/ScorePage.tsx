/**
 * 악보 뷰어 (설계문서 §7): PDF/이미지 렌더 + 수동 마디 매핑 + 필기 오버레이 + 파트보 전환.
 * 마디 클릭 → 해당 마디부터 메트로놈 연습으로 이동 (마디 번호 = 공통 좌표계).
 */
import type { MeasureMapOut, MeasureRegion, ScoreOut } from '@feelmyrythm/protocol';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiBlob } from '../lib/api';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

type Mode = 'view' | 'map' | 'draw';

interface Stroke {
  page: number;
  color: string;
  width: number;
  /** [x0,y0,x1,y1,...] 페이지 정규화 좌표 */
  points: number[];
}

export default function ScorePage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const repId = params.get('rep');
  const navigate = useNavigate();

  const [scores, setScores] = useState<ScoreOut[]>([]);
  const [meta, setMeta] = useState<ScoreOut | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [regions, setRegions] = useState<MeasureRegion[]>([]);
  const [numberOffset, setNumberOffset] = useState(0);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [sharedStrokes, setSharedStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<Mode>('view');
  const [nextMeasure, setNextMeasure] = useState(1);
  const [scope, setScope] = useState<'private' | 'project'>('private');
  const [message, setMessage] = useState('');

  // 메타 + 파일 + 매핑 + 필기 로드
  useEffect(() => {
    if (!id || !repId) return;
    (async () => {
      try {
        const list = await api<ScoreOut[]>(`/api/repertoire/${repId}/scores`);
        setScores(list);
        const m = list.find((s) => s.id === id) ?? null;
        setMeta(m);
        if (!m) return;

        const blob = await apiBlob(`/api/scores/${id}/file`);
        if (m.contentType.includes('pdf') || m.filename.toLowerCase().endsWith('.pdf')) {
          const doc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
          setPdfDoc(doc);
        } else if (m.contentType.startsWith('image/')) {
          setImageUrl(URL.createObjectURL(blob));
        } else {
          setMessage('이 형식은 미리보기를 지원하지 않습니다. MusicXML은 템포맵 편집기에서 가져오세요.');
        }

        try {
          const mm = await api<MeasureMapOut>(`/api/scores/${id}/measure-map`);
          setRegions(mm.regions);
          setNumberOffset(mm.measureNumberOffset);
          setNextMeasure(Math.max(0, ...mm.regions.map((r) => r.measureNumber)) + 1);
        } catch {
          // 매핑 없음 — 정상
        }
        try {
          const annots = await api<{ scope: string; data: { strokes?: Stroke[] } }[]>(
            `/api/scores/${id}/annotations`,
          );
          const mine: Stroke[] = [];
          const shared: Stroke[] = [];
          for (const a of annots) (a.scope === 'private' ? mine : shared).push(...(a.data.strokes ?? []));
          setStrokes(mine);
          setSharedStrokes(shared);
        } catch {
          // 필기 없음
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [id, repId]);

  const pageCount = pdfDoc?.numPages ?? (imageUrl ? 1 : 0);

  const saveMap = async () => {
    await api(`/api/scores/${id}/measure-map`, {
      method: 'PUT',
      json: { regions, measureNumberOffset: numberOffset },
    });
    setMessage(`마디 매핑 ${regions.length}개 저장됨`);
  };

  const saveStrokes = async () => {
    await api(`/api/scores/${id}/annotations`, {
      method: 'PUT',
      json: { scope, data: { strokes } },
    });
    setMessage('필기 저장됨' + (scope === 'project' ? ' (프로젝트 공유)' : ''));
  };

  const onRegionClick = useCallback(
    (r: MeasureRegion) => {
      if (mode !== 'view') return;
      const measure = r.measureNumber + numberOffset;
      if (confirm(`${measure}마디부터 메트로놈으로 연습할까요?`)) {
        navigate(`/?rep=${repId}&measure=${measure}`);
      }
    },
    [mode, numberOffset, repId, navigate],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* 파트보 전환: 같은 마디 좌표계 공유 (설계문서 §7.2) */}
        <select
          className="select"
          value={id}
          onChange={(e) => navigate(`/score/${e.target.value}?rep=${repId}`)}
        >
          {scores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.kind === 'full' ? '총보' : `파트보 · ${s.instrument || '?'}`} — {s.filename}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          {(['view', 'map', 'draw'] as Mode[]).map((m) => (
            <button
              key={m}
              className="btn"
              style={mode === m ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              onClick={() => setMode(m)}
            >
              {m === 'view' ? '보기' : m === 'map' ? '마디 매핑' : '필기'}
            </button>
          ))}
        </div>
        {mode === 'map' && (
          <>
            <label className="flex items-center gap-1 text-sm">
              다음 마디 번호
              <input
                type="number"
                className="input tnum w-20"
                value={nextMeasure}
                onChange={(e) => setNextMeasure(Number(e.target.value) || 1)}
              />
            </label>
            <button className="btn" onClick={() => setRegions((r) => r.slice(0, -1))}>
              실행취소
            </button>
            <button className="btn btn-primary" onClick={saveMap}>
              매핑 저장
            </button>
          </>
        )}
        {mode === 'draw' && (
          <>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="private">개인 필기</option>
              <option value="project">프로젝트 공유</option>
            </select>
            <button className="btn" onClick={() => setStrokes([])}>
              모두 지우기
            </button>
            <button className="btn btn-primary" onClick={saveStrokes}>
              필기 저장
            </button>
          </>
        )}
        {message && <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</span>}
      </div>

      {mode === 'map' && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          악보 위에서 마디 하나를 드래그해 상자를 그리면 번호가 자동으로 매겨집니다 (페이지당 1분 목표).
        </p>
      )}

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {Array.from({ length: pageCount }, (_, i) => (
          <PageBlock
            key={i}
            pageNum={i + 1}
            pdfDoc={pdfDoc}
            imageUrl={imageUrl}
            regions={regions.filter((r) => r.page === i + 1)}
            mode={mode}
            onAddRegion={(rect) => {
              setRegions((prev) => [...prev, { page: i + 1, measureNumber: nextMeasure, rect }]);
              setNextMeasure((n) => n + 1);
            }}
            strokes={[...sharedStrokes, ...strokes].filter((s) => s.page === i + 1)}
            onAddStroke={(points) =>
              setStrokes((prev) => [...prev, { page: i + 1, color: '#d4a853', width: 2, points }])
            }
            onRegionClick={onRegionClick}
          />
        ))}
      </div>
    </div>
  );
}

// ---------- 페이지 1장: PDF/이미지 캔버스 + 오버레이 ----------

interface PageBlockProps {
  pageNum: number;
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  imageUrl: string | null;
  regions: MeasureRegion[];
  mode: Mode;
  onAddRegion: (rect: { x: number; y: number; w: number; h: number }) => void;
  strokes: Stroke[];
  onAddStroke: (points: number[]) => void;
  onRegionClick: (r: MeasureRegion) => void;
}

function PageBlock({
  pageNum,
  pdfDoc,
  imageUrl,
  regions,
  mode,
  onAddRegion,
  strokes,
  onAddStroke,
  onRegionClick,
}: PageBlockProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const annotRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const strokeRef = useRef<number[] | null>(null);

  // PDF 페이지 렌더
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !wrapRef.current) return;
    let cancelled = false;
    (async () => {
      const page = await pdfDoc.getPage(pageNum);
      if (cancelled) return;
      const containerW = wrapRef.current!.clientWidth;
      const base = page.getViewport({ scale: 1 });
      const scale = containerW / base.width;
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const canvas = canvasRef.current!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${containerW}px`;
      const h = (base.height / base.width) * containerW;
      canvas.style.height = `${h}px`;
      setSize({ w: containerW, h });
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNum]);

  // 이미지 렌더
  useEffect(() => {
    if (!imageUrl || !canvasRef.current || !wrapRef.current) return;
    const img = new Image();
    img.onload = () => {
      const containerW = wrapRef.current!.clientWidth;
      const h = (img.naturalHeight / img.naturalWidth) * containerW;
      const canvas = canvasRef.current!;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = containerW * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${containerW}px`;
      canvas.style.height = `${h}px`;
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      setSize({ w: containerW, h });
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // 필기 레이어 렌더
  useEffect(() => {
    const canvas = annotRef.current;
    if (!canvas || !size) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    for (const s of strokes) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i + 1 < s.points.length; i += 2) {
        const x = s.points[i]! * size.w;
        const y = s.points[i + 1]! * size.h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [strokes, size]);

  const norm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = wrapRef.current;
    if (!el || !size) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / size.w)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / size.h)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = norm(e);
    if (!p) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    if (mode === 'map') dragRef.current = p;
    else if (mode === 'draw') strokeRef.current = [p.x, p.y];
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = norm(e);
    if (!p) return;
    if (mode === 'map' && dragRef.current) {
      const s = dragRef.current;
      setDragRect({
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      });
    } else if (mode === 'draw' && strokeRef.current && size) {
      strokeRef.current.push(p.x, p.y);
      // 진행 중 스트로크 즉시 그리기
      const ctx = annotRef.current!.getContext('2d')!;
      const n = strokeRef.current.length;
      if (n >= 4) {
        ctx.strokeStyle = '#d4a853';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(strokeRef.current[n - 4]! * size.w, strokeRef.current[n - 3]! * size.h);
        ctx.lineTo(strokeRef.current[n - 2]! * size.w, strokeRef.current[n - 1]! * size.h);
        ctx.stroke();
      }
    }
  };

  const onPointerUp = () => {
    if (mode === 'map' && dragRect && dragRect.w > 0.01 && dragRect.h > 0.01) {
      onAddRegion(dragRect);
    }
    dragRef.current = null;
    setDragRect(null);
    if (mode === 'draw' && strokeRef.current && strokeRef.current.length >= 4) {
      onAddStroke(strokeRef.current);
    }
    strokeRef.current = null;
  };

  return (
    <div
      ref={wrapRef}
      className="relative select-none"
      style={{ touchAction: mode === 'view' ? 'auto' : 'none', background: '#fff', borderRadius: 8 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} style={{ display: 'block', borderRadius: 8 }} />
      <canvas ref={annotRef} className="pointer-events-none absolute left-0 top-0" />
      {/* 마디 영역 오버레이 */}
      {size &&
        regions.map((r, i) => (
          <div
            key={i}
            title={`${r.measureNumber}마디`}
            className="absolute flex items-start justify-start"
            style={{
              left: r.rect.x * size.w,
              top: r.rect.y * size.h,
              width: r.rect.w * size.w,
              height: r.rect.h * size.h,
              border: '1.5px solid rgba(212,168,83,0.7)',
              background: 'rgba(212,168,83,0.08)',
              borderRadius: 4,
              cursor: mode === 'view' ? 'pointer' : 'default',
              pointerEvents: mode === 'view' ? 'auto' : 'none',
            }}
            onClick={() => onRegionClick(r)}
          >
            <span
              className="tnum px-1 text-xs font-semibold"
              style={{ background: 'rgba(212,168,83,0.9)', color: '#14110a', borderRadius: '4px 0 4px 0' }}
            >
              {r.measureNumber}
            </span>
          </div>
        ))}
      {/* 드래그 중인 상자 */}
      {size && dragRect && (
        <div
          className="absolute"
          style={{
            left: dragRect.x * size.w,
            top: dragRect.y * size.h,
            width: dragRect.w * size.w,
            height: dragRect.h * size.h,
            border: '1.5px dashed var(--accent)',
          }}
        />
      )}
    </div>
  );
}
