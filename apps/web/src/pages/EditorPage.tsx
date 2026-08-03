/** 템포맵 편집기 (설계문서 §4.4, 구현 로드맵 Phase 2). ?rep=<곡id>면 서버 저장/불러오기 연동 */
import {
  expandTimeline,
  validateTempoMap,
  type JumpDirective,
  type NoteValue,
  type TempoMap,
  type TempoSection,
} from '@feelmyrythm/core';
import type { TempoMapOut } from '@feelmyrythm/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deleteLocalMap, listLocalMaps, newLocalMap, saveLocalMap } from '../lib/localMaps';
import { parseMusicXml, toTempoMapDraft } from '../lib/musicxml';

const NOTE_VALUES: { value: NoteValue; label: string }[] = [
  { value: 'quarter', label: '♩ (4분)' },
  { value: 'dottedQuarter', label: '♩. (점4분)' },
  { value: 'eighth', label: '♪ (8분)' },
  { value: 'half', label: '𝅗𝅥 (2분)' },
];

type RepeatJump = Extract<JumpDirective, { type: 'repeat' }>;

export default function EditorPage() {
  const [params] = useSearchParams();
  const repId = params.get('rep');
  const token = useAuth((s) => s.token);

  const [maps, setMaps] = useState<TempoMap[]>(listLocalMaps);
  const [map, setMap] = useState<TempoMap | null>(null);
  const [serverRevision, setServerRevision] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // 서버 곡과 연동해 열기
  useEffect(() => {
    if (!repId || !token) return;
    api<TempoMapOut>(`/api/repertoire/${repId}/tempomap`)
      .then((r) => {
        setMap(r.data as TempoMap);
        setServerRevision(r.revision);
      })
      .catch((e) => {
        if (e.status === 404) {
          setMap(newLocalMap('새 템포맵'));
          setServerRevision(0);
        } else setMessage(e.message);
      });
  }, [repId, token]);

  const issues = useMemo(() => (map ? validateTempoMap(map) : []), [map]);
  const preview = useMemo(() => {
    if (!map || issues.length > 0) return null;
    try {
      const tl = expandTimeline(map);
      const min = Math.floor(tl.totalDurationSec / 60);
      const sec = Math.round(tl.totalDurationSec % 60);
      return { measures: tl.entries.length, duration: `${min}분 ${sec}초` };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [map, issues]);

  const update = (patch: Partial<TempoMap>) => setMap((m) => (m ? { ...m, ...patch } : m));

  const updateSection = (i: number, patch: Partial<TempoSection>) => {
    if (!map) return;
    const sections = map.sections.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    update({ sections });
  };

  const splitSection = (i: number) => {
    if (!map) return;
    const s = map.sections[i]!;
    if (s.endMeasure <= s.startMeasure) return;
    const mid = Math.floor((s.startMeasure + s.endMeasure) / 2) + 1;
    const sections = [...map.sections];
    sections.splice(i, 1, { ...s, endMeasure: mid - 1 }, { ...s, id: `s${Date.now()}`, startMeasure: mid });
    update({ sections });
  };

  const removeSection = (i: number) => {
    if (!map || map.sections.length <= 1) return;
    const removed = map.sections[i]!;
    const sections = map.sections.filter((_, idx) => idx !== i).map((s) => ({ ...s }));
    // 빈틈 메우기: 인접 구간을 늘림
    if (i > 0) sections[i - 1]!.endMeasure = removed.endMeasure;
    else sections[0]!.startMeasure = removed.startMeasure;
    update({ sections });
  };

  const repeats = (map?.jumps.filter((j) => j.type === 'repeat') ?? []) as RepeatJump[];

  const updateRepeat = (i: number, patch: Partial<RepeatJump>) => {
    if (!map) return;
    let ri = -1;
    const jumps = map.jumps.map((j) => {
      if (j.type !== 'repeat') return j;
      ri++;
      return ri === i ? { ...j, ...patch } : j;
    });
    update({ jumps });
  };

  const saveLocal = () => {
    if (!map) return;
    saveLocalMap(map);
    setMaps(listLocalMaps());
    setMessage('로컬에 저장했습니다');
  };

  const saveServer = async () => {
    if (!map || !repId) return;
    try {
      const res = await api<TempoMapOut>(`/api/repertoire/${repId}/tempomap`, {
        method: 'PUT',
        json: { baseRevision: serverRevision ?? 0, data: { ...map, revision: (serverRevision ?? 0) + 1 } },
      });
      setServerRevision(res.revision);
      setMap((m) => (m ? { ...m, revision: res.revision } : m));
      setMessage(`서버에 저장했습니다 (revision ${res.revision}) — 진행 중인 세션에 자동 반영됩니다`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const importXml = async (file: File) => {
    try {
      const result = await parseMusicXml(file);
      const draft = toTempoMapDraft(result, map?.id ?? crypto.randomUUID());
      setMap((m) => ({ ...draft, id: m?.id ?? draft.id, title: m?.title ?? draft.title }));
      setWarnings(result.warnings);
      setMessage(`MusicXML에서 ${result.totalMeasures}마디를 인식했습니다`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  if (!map) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="section-title">템포맵</h1>
        {repId && !token && (
          <div className="card">
            서버 곡과 연동하려면 <Link to="/login">로그인</Link>이 필요합니다.
          </div>
        )}
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => setMap(newLocalMap('새 템포맵'))}>
            새 템포맵 만들기
          </button>
        </div>
        {maps.length > 0 && (
          <div className="card">
            <h2 className="section-title">내 템포맵</h2>
            <ul className="flex flex-col gap-2">
              {maps.map((m) => (
                <li key={m.id} className="flex items-center gap-3">
                  <button className="btn flex-1 justify-start" onClick={() => setMap(m)}>
                    {m.title ?? '(제목 없음)'} · {m.totalMeasures}마디
                  </button>
                  <Link className="btn" to={`/?map=${m.id}`}>
                    ▶ 열기
                  </Link>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      deleteLocalMap(m.id);
                      setMaps(listLocalMaps());
                    }}
                  >
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {message && <div style={{ color: 'var(--text-secondary)' }}>{message}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-ghost" onClick={() => { setMap(null); setMaps(listLocalMaps()); }}>
          ← 목록
        </button>
        <input
          className="input flex-1"
          placeholder="제목"
          value={map.title ?? ''}
          onChange={(e) => update({ title: e.target.value })}
        />
        <label className="flex items-center gap-2 text-sm">
          총 마디
          <input
            type="number"
            className="input tnum w-24"
            min={1}
            value={map.totalMeasures}
            onChange={(e) => {
              const total = Math.max(1, Number(e.target.value) || 1);
              const sections = map.sections.map((s, i) =>
                i === map.sections.length - 1 ? { ...s, endMeasure: total } : s,
              );
              update({ totalMeasures: total, sections });
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          예비박
          <select
            className="select"
            value={map.countIn.measures}
            onChange={(e) => update({ countIn: { ...map.countIn, measures: Number(e.target.value) as 1 | 2 } })}
          >
            <option value={1}>1마디</option>
            <option value={2}>2마디</option>
          </select>
        </label>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          MusicXML 가져오기
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xml,.musicxml,.mxl"
          hidden
          onChange={(e) => e.target.files?.[0] && importXml(e.target.files[0])}
        />
      </div>

      {/* 마디 눈금 타임라인 (구간 색 블록) */}
      <div className="card" style={{ padding: 12 }}>
        <div className="flex h-10 w-full overflow-hidden rounded-lg">
          {map.sections.map((s, i) => {
            const width = ((s.endMeasure - s.startMeasure + 1) / map.totalMeasures) * 100;
            const hues = ['#d4a853', '#6aa5dd', '#6fbf9e', '#c47ad4', '#dd8b6a'];
            return (
              <div
                key={s.id}
                title={`${s.startMeasure}~${s.endMeasure}마디 · ${s.timeSignature.num}/${s.timeSignature.denom} ♩=${s.bpm}`}
                style={{
                  width: `${width}%`,
                  background: hues[i % hues.length],
                  opacity: 0.75,
                  borderRight: '1px solid var(--bg)',
                }}
                className="flex items-center justify-center text-xs font-medium"
              >
                <span style={{ color: '#14110a' }}>{s.bpm}</span>
              </div>
            );
          })}
        </div>
        <div className="tnum mt-1 flex justify-between text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>1</span>
          <span>{map.totalMeasures}마디</span>
        </div>
      </div>

      {/* 구간 편집 표 */}
      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="section-title">구간 (박자·템포)</h2>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>라벨</th>
              <th>시작</th>
              <th>끝</th>
              <th>박자표</th>
              <th>BPM</th>
              <th>1박 단위</th>
              <th>분할</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {map.sections.map((s, i) => (
              <tr key={s.id}>
                <td>
                  <input
                    className="input w-20"
                    value={s.label ?? ''}
                    placeholder={`구간${i + 1}`}
                    onChange={(e) => updateSection(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="input tnum w-20"
                    value={s.startMeasure}
                    onChange={(e) => updateSection(i, { startMeasure: Number(e.target.value) || 1 })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="input tnum w-20"
                    value={s.endMeasure}
                    onChange={(e) => updateSection(i, { endMeasure: Number(e.target.value) || 1 })}
                  />
                </td>
                <td>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      className="input tnum w-14"
                      value={s.timeSignature.num}
                      onChange={(e) =>
                        updateSection(i, { timeSignature: { ...s.timeSignature, num: Number(e.target.value) || 4 } })
                      }
                    />
                    /
                    <select
                      className="select w-16"
                      value={s.timeSignature.denom}
                      onChange={(e) =>
                        updateSection(i, { timeSignature: { ...s.timeSignature, denom: Number(e.target.value) } })
                      }
                    >
                      {[2, 4, 8, 16].map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
                <td>
                  <input
                    type="number"
                    className="input tnum w-20"
                    value={s.bpm}
                    onChange={(e) => updateSection(i, { bpm: Number(e.target.value) || 100 })}
                  />
                </td>
                <td>
                  <select
                    className="select"
                    value={s.beatUnit}
                    onChange={(e) => updateSection(i, { beatUnit: e.target.value as NoteValue })}
                  >
                    {NOTE_VALUES.map((nv) => (
                      <option key={nv.value} value={nv.value}>
                        {nv.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="select w-16"
                    value={s.subdivision ?? 1}
                    onChange={(e) => updateSection(i, { subdivision: Number(e.target.value) as 1 | 2 | 3 | 4 })}
                  >
                    {[1, 2, 3, 4].map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="flex gap-1">
                    <button className="btn btn-ghost" title="구간 나누기" onClick={() => splitSection(i)}>
                      나누기
                    </button>
                    <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => removeSection(i)}>
                      ✕
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 반복 구조 */}
      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="section-title">반복 (도돌이 · 엔딩)</h2>
          <button
            className="btn"
            onClick={() =>
              update({
                jumps: [...map.jumps, { type: 'repeat', startMeasure: 1, endMeasure: 8, times: 2 } as JumpDirective],
              })
            }
          >
            + 도돌이 추가
          </button>
        </div>
        {repeats.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            반복 없음 — 처음부터 끝까지 순서대로 연주합니다.
          </p>
        )}
        {repeats.map((r, i) => (
          <div key={i} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="tnum">
              <input
                type="number"
                className="input tnum w-20"
                value={r.startMeasure}
                onChange={(e) => updateRepeat(i, { startMeasure: Number(e.target.value) || 1 })}
              />
              {' ~ '}
              <input
                type="number"
                className="input tnum w-20"
                value={r.endMeasure}
                onChange={(e) => updateRepeat(i, { endMeasure: Number(e.target.value) || 1 })}
              />
              마디,
            </span>
            <label>
              총{' '}
              <input
                type="number"
                className="input tnum w-16"
                min={2}
                value={r.times}
                onChange={(e) => updateRepeat(i, { times: Math.max(2, Number(e.target.value) || 2) })}
              />
              회
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!r.endings}
                onChange={(e) =>
                  updateRepeat(i, {
                    endings: e.target.checked
                      ? [
                          { measures: [r.endMeasure, r.endMeasure], forPass: [1] },
                          { measures: [r.endMeasure + 1, r.endMeasure + 1], forPass: [2] },
                        ]
                      : undefined,
                  })
                }
              />
              1st/2nd 엔딩
            </label>
            {r.endings?.map((e, ei) => (
              <span key={ei} className="chip tnum">
                {ei + 1}번:
                <input
                  type="number"
                  className="input tnum w-16"
                  value={e.measures[0]}
                  onChange={(ev) => {
                    const endings = r.endings!.map((x, xi) =>
                      xi === ei ? { ...x, measures: [Number(ev.target.value) || 1, x.measures[1]] as [number, number] } : x,
                    );
                    updateRepeat(i, { endings });
                  }}
                />
                ~
                <input
                  type="number"
                  className="input tnum w-16"
                  value={e.measures[1]}
                  onChange={(ev) => {
                    const endings = r.endings!.map((x, xi) =>
                      xi === ei ? { ...x, measures: [x.measures[0], Number(ev.target.value) || 1] as [number, number] } : x,
                    );
                    updateRepeat(i, { endings });
                  }}
                />
              </span>
            ))}
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--danger)' }}
              onClick={() => {
                let ri = -1;
                update({
                  jumps: map.jumps.filter((j) => {
                    if (j.type !== 'repeat') return true;
                    ri++;
                    return ri !== i;
                  }),
                });
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 검증 · 미리보기 · 저장 */}
      <div className="card flex flex-col gap-3">
        {issues.length > 0 ? (
          <ul className="text-sm" style={{ color: 'var(--danger)' }}>
            {issues.map((issue, i) => (
              <li key={i}>⚠ {issue}</li>
            ))}
          </ul>
        ) : preview && 'error' in preview ? (
          <div className="text-sm" style={{ color: 'var(--danger)' }}>
            ⚠ {preview.error}
          </div>
        ) : preview ? (
          <div className="tnum text-sm" style={{ color: 'var(--success)' }}>
            ✓ 연주 순서로 펼치면 총 {preview.measures}마디 · {preview.duration}
          </div>
        ) : null}
        {warnings.map((w, i) => (
          <div key={i} className="text-sm" style={{ color: 'var(--accent)' }}>
            {w}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={saveLocal}>
            로컬 저장
          </button>
          {repId && token && (
            <button className="btn btn-primary" onClick={saveServer} disabled={issues.length > 0}>
              서버에 저장 {serverRevision !== null && `(현재 rev ${serverRevision})`}
            </button>
          )}
          <Link className="btn btn-primary" to={`/?map=${map.id}`} onClick={saveLocal}>
            ▶ 메트로놈에서 열기
          </Link>
        </div>
        {message && <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</div>}
      </div>
    </div>
  );
}
