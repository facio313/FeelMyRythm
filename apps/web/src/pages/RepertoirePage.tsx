/** 곡 상세: 템포맵 · 동기 세션 · 악보 · 연습일지 · 할일 */
import type {
  PracticeLogOut,
  RepertoireOut,
  RoomCreated,
  ScoreOut,
  TodoOut,
} from '@feelmyrythm/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, apiUpload } from '../lib/api';

export default function RepertoirePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [item, setItem] = useState<RepertoireOut | null>(null);
  const [scores, setScores] = useState<ScoreOut[]>([]);
  const [logs, setLogs] = useState<PracticeLogOut[]>([]);
  const [todos, setTodos] = useState<TodoOut[]>([]);
  const [error, setError] = useState('');

  const [logContent, setLogContent] = useState('');
  const [logMeasure, setLogMeasure] = useState('');
  const [todoContent, setTodoContent] = useState('');
  const [uploadKind, setUploadKind] = useState<'full' | 'part'>('full');
  const [uploadInstrument, setUploadInstrument] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [rep, sc, lg, td] = await Promise.all([
        api<RepertoireOut>(`/api/repertoire/${id}`),
        api<ScoreOut[]>(`/api/repertoire/${id}/scores`),
        api<PracticeLogOut[]>(`/api/repertoire/${id}/logs`),
        api<TodoOut[]>(`/api/repertoire/${id}/todos`),
      ]);
      setItem(rep);
      setScores(sc);
      setLogs(lg);
      setTodos(td);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!item) return <div>{error || '불러오는 중…'}</div>;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">{item.title}</h1>
        <div style={{ color: 'var(--text-secondary)' }}>{item.composer || '작곡가 미상'}</div>
      </div>
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}

      {/* 템포맵 + 세션 */}
      <div className="card flex flex-wrap items-center gap-3">
        <span className="chip">{item.hasTempoMap ? '✓ 템포맵 있음' : '템포맵 없음'}</span>
        <Link className="btn" to={`/editor?rep=${item.id}`}>
          템포맵 편집
        </Link>
        {item.hasTempoMap && (
          <Link className="btn" to={`/?rep=${item.id}`}>
            ▶ 메트로놈으로 열기
          </Link>
        )}
        <button
          className="btn btn-primary"
          disabled={!item.hasTempoMap}
          title={item.hasTempoMap ? '' : '템포맵을 먼저 만드세요'}
          onClick={async () => {
            try {
              const room = await api<RoomCreated>('/api/rooms', { method: 'POST', json: { repertoireId: item.id } });
              navigate(`/session/${room.roomId}`);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          앙상블 세션 열기
        </button>
      </div>

      {/* 악보 */}
      <div className="card">
        <h2 className="section-title">악보 (총보/파트보)</h2>
        <div className="grid gap-2 md:grid-cols-2">
          {scores.map((s) => (
            <Link key={s.id} to={`/score/${s.id}?rep=${item.id}`} className="btn justify-between">
              <span>
                {s.kind === 'full' ? '총보' : `파트보 · ${s.instrument || '?'}`} — {s.filename}
              </span>
              <span className="text-xs" style={{ color: s.hasMeasureMap ? 'var(--success)' : 'var(--text-muted)' }}>
                {s.hasMeasureMap ? '✓ 마디 매핑' : '매핑 필요'}
              </span>
            </Link>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select className="select" value={uploadKind} onChange={(e) => setUploadKind(e.target.value as 'full' | 'part')}>
            <option value="full">총보</option>
            <option value="part">파트보</option>
          </select>
          {uploadKind === 'part' && (
            <input
              className="input w-32"
              placeholder="악기 (예: Vn1)"
              value={uploadInstrument}
              onChange={(e) => setUploadInstrument(e.target.value)}
            />
          )}
          <button className="btn" onClick={() => fileRef.current?.click()}>
            악보 업로드 (PDF/이미지/MusicXML)
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.xml,.musicxml,.mxl"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.set('file', file);
              form.set('kind', uploadKind);
              form.set('instrument', uploadInstrument);
              try {
                await apiUpload(`/api/repertoire/${item.id}/scores`, form);
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* 연습일지 */}
        <div className="card">
          <h2 className="section-title">연습일지</h2>
          <form
            className="mb-3 flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const anchors = logMeasure ? [{ measureNumber: Number(logMeasure) }] : [];
              try {
                await api(`/api/repertoire/${item.id}/logs`, {
                  method: 'POST',
                  json: { content: logContent, anchors },
                });
                setLogContent('');
                setLogMeasure('');
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <textarea
              className="input"
              rows={2}
              placeholder="예: 26마디 crescendo 주의, 셈여림 pp→f"
              value={logContent}
              onChange={(e) => setLogContent(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                type="number"
                className="input tnum w-28"
                placeholder="마디 앵커"
                value={logMeasure}
                onChange={(e) => setLogMeasure(e.target.value)}
              />
              <button className="btn" disabled={!logContent.trim()}>
                기록
              </button>
            </div>
          </form>
          <ul className="flex flex-col gap-2 text-sm">
            {logs.map((l) => (
              <li key={l.id} className="rounded-lg p-2" style={{ background: 'var(--surface-raised)' }}>
                <div className="flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
                  <span>{l.authorName}</span>
                  <span>{new Date(l.createdAt).toLocaleString('ko')}</span>
                </div>
                <div className="mt-1 whitespace-pre-wrap">{l.content}</div>
                {l.anchors.map((a, i) =>
                  a.measureNumber ? (
                    <Link key={i} className="chip mt-1" to={`/?rep=${item.id}&measure=${a.measureNumber}`}>
                      {a.measureNumber}마디부터 연습 ▶
                    </Link>
                  ) : null,
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* 할일 */}
        <div className="card">
          <h2 className="section-title">할일</h2>
          <form
            className="mb-3 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/api/repertoire/${item.id}/todos`, { method: 'POST', json: { content: todoContent } });
                setTodoContent('');
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <input
              className="input flex-1"
              placeholder="예: 활 정리, 호흡 맞추기"
              value={todoContent}
              onChange={(e) => setTodoContent(e.target.value)}
            />
            <button className="btn" disabled={!todoContent.trim()}>
              추가
            </button>
          </form>
          <ul className="flex flex-col gap-1">
            {todos.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={async () => {
                      await api(`/api/todos/${t.id}`, { method: 'PATCH' });
                      await load();
                    }}
                  />
                  <span style={t.done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
                    {t.content}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
