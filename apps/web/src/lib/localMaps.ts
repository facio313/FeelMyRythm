/** 템포맵 로컬 저장 (구현 로드맵 Phase 2 — 서버 없이도 솔로 연습 가능) */
import { createDefaultTempoMap, type TempoMap } from '@feelmyrythm/core';

const KEY = 'fmr-tempomaps';

export function listLocalMaps(): TempoMap[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as TempoMap[];
  } catch {
    return [];
  }
}

export function saveLocalMap(map: TempoMap): void {
  const maps = listLocalMaps().filter((m) => m.id !== map.id);
  maps.unshift(map);
  localStorage.setItem(KEY, JSON.stringify(maps.slice(0, 50)));
}

export function deleteLocalMap(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(listLocalMaps().filter((m) => m.id !== id)));
}

export function newLocalMap(title: string): TempoMap {
  const map = createDefaultTempoMap({ title });
  saveLocalMap(map);
  return map;
}

// ---- 기기 캘리브레이션 (설계문서 §6.5) ----

const CAL_KEY = 'fmr-calibration-ms';

export function getCalibrationMs(): number {
  const v = Number(localStorage.getItem(CAL_KEY));
  return Number.isFinite(v) ? v : 0;
}

export function setCalibrationMs(ms: number): void {
  localStorage.setItem(CAL_KEY, String(Math.round(ms)));
}
