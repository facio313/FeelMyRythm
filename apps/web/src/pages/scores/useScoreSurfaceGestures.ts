import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from 'react';

import type { LocalMeasureMap, LocalScore } from '../../lib/localDb';
import { canonicalMeasureNumber } from '../../lib/scoreApi';
import {
  isUsableSystemRect,
  keyboardMeasureTarget,
  mappedMeasuresForKeyboard,
  pointerPosition,
  rectFromDrag,
  regionContainsPoint,
  toggleBoundary,
} from './scoreGeometry';
import type { AnnotationMode, NormalizedRect, PenPoint } from './types';

export function useScoreSurfaceGestures({
  mode,
  setMode,
  measureMap,
  page,
  currentMeasure,
  selected,
  dragStart,
  setDragStart,
  systemRect,
  setSystemRect,
  setBoundaries,
  activePenPoints,
  setActivePenPoints,
  activeSurfacePointerIdRef,
  saveAnnotation,
  savePenAnnotation,
  selectCanonicalMeasure,
}: {
  mode: AnnotationMode;
  setMode: Dispatch<SetStateAction<AnnotationMode>>;
  measureMap?: LocalMeasureMap | undefined;
  page: number;
  currentMeasure: number;
  selected?: LocalScore | undefined;
  dragStart?: { x: number; y: number } | undefined;
  setDragStart: Dispatch<SetStateAction<{ x: number; y: number } | undefined>>;
  systemRect?: NormalizedRect | undefined;
  setSystemRect: Dispatch<SetStateAction<NormalizedRect | undefined>>;
  setBoundaries: Dispatch<SetStateAction<number[]>>;
  activePenPoints: PenPoint[];
  setActivePenPoints: Dispatch<SetStateAction<PenPoint[]>>;
  activeSurfacePointerIdRef: MutableRefObject<number | null>;
  saveAnnotation: (
    point: { x: number; y: number },
    anchorType?: 'page' | 'measure',
  ) => Promise<void>;
  savePenAnnotation: (points: PenPoint[]) => Promise<void>;
  selectCanonicalMeasure: (canonical: number, page?: number) => Promise<void>;
}): {
  scoreSurfaceKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  pointerDown: (event: ReactPointerEvent) => void;
  pointerMove: (event: ReactPointerEvent) => void;
  pointerUp: (event: ReactPointerEvent) => void;
  pointerCancel: (event: ReactPointerEvent) => void;
} {
  const scoreSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && mode !== 'view') {
      event.preventDefault();
      setMode('view');
      return;
    }
    if ((mode === 'text' || mode === 'stamp') && event.key === 'Enter') {
      event.preventDefault();
      void saveAnnotation({ x: 0.5, y: 0.5 }, 'measure');
      return;
    }
    if (mode !== 'view' || !measureMap) return;
    const target = keyboardMeasureTarget(
      mappedMeasuresForKeyboard(measureMap.regions, measureMap.measureNumberOffset),
      currentMeasure,
      event.key,
    );
    if (!target) return;
    event.preventDefault();
    void selectCanonicalMeasure(target.canonical, target.page);
  };

  const pointerDown = (event: ReactPointerEvent) => {
    if (activeSurfacePointerIdRef.current !== null) return;
    if (mode === 'system') {
      event.preventDefault();
      activeSurfacePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragStart(pointerPosition(event));
      return;
    }
    if (mode === 'pen') {
      event.preventDefault();
      activeSurfacePointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      setActivePenPoints([pointerPosition(event)]);
    }
  };

  const pointerMove = (event: ReactPointerEvent) => {
    if (
      mode !== 'pen' ||
      activeSurfacePointerIdRef.current !== event.pointerId ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    const point = pointerPosition(event);
    setActivePenPoints((current) => {
      const previous = current.at(-1);
      if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 0.002) {
        return current;
      }
      return [...current, point];
    });
  };

  const pointerUp = (event: ReactPointerEvent) => {
    if (
      (mode === 'pen' || mode === 'system') &&
      activeSurfacePointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    const point = pointerPosition(event);
    if (
      activeSurfacePointerIdRef.current === event.pointerId &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (activeSurfacePointerIdRef.current === event.pointerId) {
      activeSurfacePointerIdRef.current = null;
    }
    if (mode === 'pen') {
      const points = [...activePenPoints, point];
      setActivePenPoints([]);
      void savePenAnnotation(points);
      return;
    }
    if (mode === 'view') {
      const target = measureMap?.regions.find((region) => regionContainsPoint(region, page, point));
      if (target) {
        const canonical = canonicalMeasureNumber(
          target.measureNumber,
          measureMap?.measureNumberOffset ?? 0,
        );
        if (canonical !== undefined) void selectCanonicalMeasure(canonical, target.page);
      }
      return;
    }
    if (mode === 'system' && dragStart) {
      const rect = rectFromDrag(dragStart, point);
      if (isUsableSystemRect(rect)) {
        setSystemRect(rect);
        setBoundaries([]);
        setMode('boundaries');
      }
      setDragStart(undefined);
      return;
    }
    if (mode === 'boundaries' && systemRect) {
      const relative = (point.x - systemRect.x) / systemRect.w;
      if (relative > 0.02 && relative < 0.98) {
        setBoundaries((current) => toggleBoundary(current, relative));
      }
      return;
    }
    if ((mode === 'text' || mode === 'stamp') && selected) {
      void saveAnnotation(point);
    }
  };

  const pointerCancel = (event: ReactPointerEvent) => {
    if (activeSurfacePointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeSurfacePointerIdRef.current = null;
    setDragStart(undefined);
    setActivePenPoints([]);
  };

  return {
    scoreSurfaceKeyDown,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
  };
}
