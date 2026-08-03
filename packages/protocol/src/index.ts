/**
 * 클라-서버 공유 타입.
 * 원천은 서버(apps/server/app/schemas.py)의 Pydantic 모델이며, 이 파일은 그와 1:1로 유지한다.
 * TODO(설계문서 §11): OpenAPI → openapi-typescript 자동 생성 파이프라인으로 교체.
 */

// ---------- 도메인 DTO ----------

export interface UserOut {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthResponse {
  token: string;
  user: UserOut;
}

export interface GroupOut {
  id: string;
  name: string;
  myRole: 'owner' | 'leader' | 'member';
}

export interface GroupMemberOut {
  userId: string;
  displayName: string;
  email: string;
  role: 'owner' | 'leader' | 'member';
}

export interface ProjectOut {
  id: string;
  groupId: string;
  name: string;
  description: string;
}

export interface RepertoireOut {
  id: string;
  projectId: string;
  title: string;
  composer: string;
  hasTempoMap: boolean;
  scoreCount: number;
  openTodoCount: number;
}

export interface TempoMapOut {
  revision: number;
  /** @feelmyrythm/core 의 TempoMap JSON */
  data: unknown;
}

export interface ScoreOut {
  id: string;
  repertoireId: string;
  kind: 'full' | 'part';
  instrument: string;
  filename: string;
  contentType: string;
  measureNumberOffset: number;
  hasMeasureMap: boolean;
}

export interface MeasureRegion {
  page: number;
  measureNumber: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface MeasureMapOut {
  regions: MeasureRegion[];
  measureNumberOffset: number;
}

export interface PracticeLogOut {
  id: string;
  repertoireId: string;
  authorName: string;
  content: string;
  /** 마디 앵커 등 */
  anchors: { measureNumber?: number; note?: string }[];
  createdAt: string;
}

export interface TodoOut {
  id: string;
  repertoireId: string;
  content: string;
  assignee: string;
  done: boolean;
}

export interface RoomCreated {
  roomId: string;
}

// ---------- WS 메시지 (설계문서 §6.3) ----------

export interface TransportState {
  roomId: string;
  repertoireId: string;
  tempoMapRevision: number;
  status: 'idle' | 'playing';
  anchor?: { measure: number; pass: number };
  /** 예비박 첫 박의 서버 시각 (epoch ms) */
  serverStartTime?: number;
  /** 예비박 포함 여부 */
  countIn: boolean;
}

export interface RosterMember {
  userId: string;
  displayName: string;
  isLeader: boolean;
  rttMs?: number;
}

export type WsClientMessage =
  | { type: 'PING'; t0: number }
  | { type: 'CMD_START'; measure: number; pass?: number; countIn?: boolean }
  | { type: 'CMD_STOP' }
  | { type: 'REPORT_RTT'; rttMs: number };

export type WsServerMessage =
  | { type: 'PONG'; t0: number; t1: number }
  | { type: 'TRANSPORT'; state: TransportState }
  | { type: 'ROOM_ROSTER'; members: RosterMember[] }
  | { type: 'TEMPOMAP_UPDATED'; revision: number }
  | { type: 'ERROR'; message: string };
