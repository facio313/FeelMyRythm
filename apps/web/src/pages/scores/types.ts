export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationMode = 'view' | 'system' | 'boundaries' | 'pen' | 'text' | 'stamp';
export type AnnotationScope = 'private' | 'project';

export interface PenPoint {
  x: number;
  y: number;
}

export interface MeasureRegion {
  id: string;
  page: number;
  measureNumber: number;
  rect: NormalizedRect;
}
