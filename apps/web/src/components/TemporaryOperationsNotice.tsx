import { Button, Modal, StatusBadge } from '@feelmyrythm/ui';
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { managedLocalSsoModeEnabled } from '../lib/runtimeMode';

export const temporaryOperationsTasks = [
  {
    status: '적용 중',
    title: '악보 파일을 서버 전용 영구 볼륨에 저장',
    detail: '볼륨 삭제와 stack-wide down -v는 금지되어 있습니다.',
  },
  {
    status: '적용 중',
    title: '중앙 통합 로그인 계정을 자동 연결',
    detail: '중앙 관리자가 만든 계정은 고유 아이디로 연결되며 로컬 비밀번호 기능은 닫혀 있습니다.',
  },
  {
    status: '해야 함',
    title: 'AWS S3를 준비하고 로컬 악보 파일 이관',
    detail: '이관과 검증이 끝날 때까지 로컬 볼륨을 보존해야 합니다.',
  },
  {
    status: '해야 함',
    title: 'SMTP 발송 도메인과 키 설정',
    detail: '설정 후 회원가입, 인증, 비밀번호 재설정 메일을 다시 엽니다.',
  },
  {
    status: '해야 함',
    title: '로컬 파일 백업과 복구 절차 확정',
    detail: 'S3 전환 전에도 악보 원본을 별도로 백업할 수 있어야 합니다.',
  },
  {
    status: '해야 함',
    title: '모바일 연결 파일과 OMR 운영 의존성 완성',
    detail: 'AASA·assetlinks 서명 정보와 Audiveris 준비 후 최종 검사를 통과합니다.',
  },
] as const;

export function TemporaryOperationsNotice({
  enabled = managedLocalSsoModeEnabled(),
}: {
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(enabled);
  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        className="icon-link temporary-operations-trigger"
        aria-label="임시 운영 할 일"
        title="임시 운영 할 일"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <CircleAlert size={20} aria-hidden />
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="임시 운영 할 일"
        description="지금 사용할 수 있도록 적용한 임시 조치와 정식 운영 전에 끝낼 작업입니다."
      >
        <div className="temporary-operations">
          <p role="status">
            현재는 중앙 계정 관리와 서버 로컬 저장소를 사용하는 임시 운영입니다. 아래 후속 항목은
            자동으로 완료되지 않습니다.
          </p>
          <ul className="temporary-operations__list">
            {temporaryOperationsTasks.map((task) => (
              <li key={task.title}>
                <StatusBadge tone={task.status === '적용 중' ? 'success' : 'warning'}>
                  {task.status}
                </StatusBadge>
                <div>
                  <strong>{task.title}</strong>
                  <p>{task.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <Button variant="primary" onClick={() => setOpen(false)}>
              확인하고 둘러보기
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
