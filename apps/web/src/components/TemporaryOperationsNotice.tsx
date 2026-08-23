import { Button, Modal, StatusBadge } from '@feelmyrythm/ui';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { managedLocalSsoModeEnabled } from '../lib/runtimeMode';

export const temporaryOperationsTasks = [
  {
    status: '적용됨',
    tone: 'success',
    title: '악보 파일을 컨테이너 외부 영구 볼륨에 저장',
    detail: '현재 단일 서버의 전용 볼륨을 사용하며 컨테이너 교체와 파일 저장 수명을 분리합니다.',
  },
  {
    status: '적용됨',
    tone: 'success',
    title: '중앙 통합 로그인 계정을 자동 연결',
    detail: '중앙 관리자가 만든 계정은 고유 아이디로 연결되며 로컬 비밀번호 기능은 닫혀 있습니다.',
  },
  {
    status: '선택',
    tone: 'info',
    title: 'S3 호환 저장소로 확장',
    detail:
      '다중 서버 공유나 서버 밖 내구성이 필요할 때만 이관합니다. 현재 로컬 볼륨 운영의 필수 조건이 아닙니다.',
  },
  {
    status: '불필요',
    tone: 'neutral',
    title: 'FeelMyRythm SMTP',
    detail: '현재 계정 가입·복구 메일은 중앙 SSO가 책임지므로 앱 SMTP를 설정하지 않습니다.',
  },
  {
    status: '권장',
    tone: 'info',
    title: '서버 악보 볼륨 별도 백업',
    detail: 'S3 사용 여부와 관계없는 권장 운영 항목이며, 현재 서비스 사용을 막지 않습니다.',
  },
  {
    status: '출시 시',
    tone: 'info',
    title: '모바일 HTTPS 연결 파일 검증',
    detail:
      '서명 앱 출시 때만 AASA·assetlinks를 검증합니다. 현재 모바일 출시는 별도 중앙 SSO bridge 구현 전까지 보류합니다.',
  },
  {
    status: '활성화 시',
    tone: 'info',
    title: 'Audiveris OMR 운영 의존성',
    detail: 'OMR 초안 기능을 제공할 때만 Audiveris 실행 환경과 자원·정확도를 검증합니다.',
  },
] as const;

export function TemporaryOperationsNotice({
  enabled = managedLocalSsoModeEnabled(),
}: {
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;

  return (
    <>
      <button
        type="button"
        className="icon-link temporary-operations-trigger"
        aria-label="현재 운영 구성 보기"
        title="현재 운영 구성"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Info size={20} aria-hidden />
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="현재 운영 구성"
        description="중앙 SSO와 서버 로컬 저장소를 사용하는 현재 구성과 필요한 시점에 선택할 운영 항목입니다."
      >
        <div className="temporary-operations">
          <p role="status">
            현재 구성으로 사용할 수 있습니다. 선택·권장 항목은 지금 사용을 막지 않으며 필요한 시점에
            검토할 수 있습니다.
          </p>
          <ul className="temporary-operations__list">
            {temporaryOperationsTasks.map((task) => (
              <li key={task.title}>
                <StatusBadge tone={task.tone}>{task.status}</StatusBadge>
                <div>
                  <strong>{task.title}</strong>
                  <p>{task.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <Button variant="primary" onClick={() => setOpen(false)}>
              확인
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
