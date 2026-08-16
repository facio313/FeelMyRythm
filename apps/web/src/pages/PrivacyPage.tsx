import { Card } from '@feelmyrythm/ui';
import { ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

const PRIVACY_CONTACT = 'privacy@bonifacio.work';

export function PrivacyPage() {
  return (
    <div className="page page--narrow legal-page">
      <PageHeader
        eyebrow="Privacy"
        title="개인정보 처리 안내"
        description="FeelMyRythm이 연습과 앙상블 동기화에 필요한 정보를 어떻게 다루는지 설명합니다."
        actions={
          <Link className="legal-page__action" to="/delete-account">
            계정 삭제 안내 열기 <ExternalLink size={16} aria-hidden />
          </Link>
        }
      />

      <div className="stack legal-page__sections">
        <Card>
          <div className="settings-heading">
            <ShieldCheck aria-hidden />
            <div>
              <h2>수집하는 정보와 목적</h2>
              <p className="subtle">시행일: 2026년 8월 15일</p>
            </div>
          </div>
          <ul>
            <li>계정: 이메일, 표시 이름, 인증 제공자 식별자와 로그인 세션</li>
            <li>협업: 그룹·프로젝트·레퍼토리, 템포맵, 할 일과 권한 정보</li>
            <li>연습: 업로드한 악보, 마디 매핑, 필기, 연습일지와 출력 지연 보정값</li>
            <li>운영: 보안, 오류 조사와 서비스 안정성에 필요한 최소 접속 기록</li>
          </ul>
          <p>
            이 정보는 계정 인증, 그룹 공유, 기기 간 동기화와 사용자가 요청한 연습 기능을 제공하는 데
            사용합니다. 광고 프로파일을 만들거나 개인정보를 판매하지 않습니다.
          </p>
        </Card>

        <Card>
          <h2>기기 권한과 로컬 처리</h2>
          <p>
            튜너의 마이크 신호는 기기 안에서 음정을 계산하는 데 사용하며 원본 오디오를 서버로
            전송하거나 저장하지 않습니다. 화면 켜짐 유지·햅틱·오디오 출력 권한은 해당 기능을 실행할
            때만 사용합니다. 로그아웃 전용 원격 오프라인 사본은 사용자별로 격리됩니다.
          </p>
        </Card>

        <Card>
          <h2>보관·공유·보호</h2>
          <p>
            계정 데이터는 서비스 제공 기간 동안 보관합니다. 악보 원본은 접근 권한이 제한된 객체
            저장소에, 계정·협업 데이터는 데이터베이스에 저장합니다. 그룹에서 공유한 항목은 그 그룹의
            권한 있는 구성원에게만 제공합니다. 서비스 운영에 필요한 인프라 제공자를 제외한 제3자에게
            사용자의 콘텐츠를 임의로 제공하지 않습니다.
          </p>
          <p>
            전송 구간 암호화, 짧은 수명의 access token, 회전하는 refresh token, 기기 보안 저장소와
            사용자별 오프라인 캐시를 사용합니다.
          </p>
        </Card>

        <Card>
          <div className="settings-heading">
            <Trash2 aria-hidden />
            <div>
              <h2>사용자의 선택과 삭제</h2>
              <p className="subtle">앱을 다시 설치하지 않아도 웹에서 삭제를 요청할 수 있습니다.</p>
            </div>
          </div>
          <p>
            설정에서 계정과 개인 데이터를 삭제할 수 있습니다. 공유 이력의 참조 무결성을 위해 작성자
            식별이 불가능한 “삭제된 사용자” 표지만 남을 수 있으며, 이메일·이름·로그인 자격증명은
            제거됩니다. 기기에만 만든 익명 솔로 연습 데이터는 브라우저 또는 운영체제의 사이트 데이터
            설정에서 별도로 지울 수 있습니다.
          </p>
        </Card>

        <Card>
          <h2>문의와 변경</h2>
          <p>
            개인정보 열람·정정·삭제 또는 이 안내에 관한 문의는{' '}
            <a className="text-link" href={`mailto:${PRIVACY_CONTACT}`}>
              {PRIVACY_CONTACT}
            </a>
            로 보내 주세요. 중요한 내용이 바뀌면 이 화면의 시행일과 안내를 갱신합니다.
          </p>
        </Card>
      </div>
    </div>
  );
}
