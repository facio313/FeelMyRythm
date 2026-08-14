import { Button, Card } from '@feelmyrythm/ui';
import { LogIn, Settings, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';

export function AccountDeletionPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="page page--narrow legal-page">
      <PageHeader
        eyebrow="Account deletion"
        title="FeelMyRythm 계정 삭제"
        description="앱을 설치하지 않아도 이 웹 경로에서 계정 삭제를 시작할 수 있습니다."
      />

      <div className="stack legal-page__sections">
        <Card>
          <div className="settings-heading">
            <Trash2 aria-hidden />
            <div>
              <h2>삭제되는 데이터</h2>
              <p className="subtle">삭제를 완료하면 계정을 복구할 수 없습니다.</p>
            </div>
          </div>
          <ul>
            <li>로그인 자격증명, 기기 보정, 개인 필기와 연습일지</li>
            <li>소유한 그룹·프로젝트·레퍼토리와 그 악보 원본</li>
            <li>다른 그룹의 멤버십과 개인 범위 데이터</li>
          </ul>
          <p>
            다른 구성원이 계속 사용하는 공유 이력에는 이메일이나 이름 대신 식별 불가능한 “삭제된
            사용자” 표지만 남을 수 있습니다. 기기에만 만든 비로그인 솔로 데이터는 계정과 분리되어
            자동 삭제되지 않습니다.
          </p>
        </Card>

        <Card>
          <h2>삭제 요청 시작</h2>
          <p>
            본인 확인을 위해 로그인한 뒤 설정의 계정 섹션에서 이메일과 재인증 정보를 입력합니다.
            요청이 끝나면 모든 기기에서 로그아웃됩니다.
          </p>
          <Button
            variant="danger"
            onClick={() => {
              if (user) {
                void navigate('/settings', { state: { openAccountDeletion: true } });
                return;
              }
              void navigate('/login', {
                state: { returnTo: '/delete-account' },
              });
            }}
          >
            {user ? <Settings size={18} aria-hidden /> : <LogIn size={18} aria-hidden />}
            {user ? '계정 설정에서 삭제 계속하기' : '로그인하고 삭제 계속하기'}
          </Button>
        </Card>

        <p className="subtle legal-page__footnote">
          삭제 과정에 문제가 있으면 privacy@bonifacio.work로 계정 이메일과 오류 발생 시각을 알려
          주세요. 비밀번호나 인증 토큰은 보내지 마세요.
        </p>
      </div>
    </div>
  );
}
