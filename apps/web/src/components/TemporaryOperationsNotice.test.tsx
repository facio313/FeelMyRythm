import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TemporaryOperationsNotice, temporaryOperationsTasks } from './TemporaryOperationsNotice';

describe('TemporaryOperationsNotice', () => {
  afterEach(cleanup);

  it('stays closed initially and opens current operations information from the top-bar trigger', () => {
    render(<TemporaryOperationsNotice enabled />);

    expect(screen.queryByRole('dialog', { name: '현재 운영 구성' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: '현재 운영 구성 보기' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '현재 운영 구성' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(temporaryOperationsTasks.length);
    for (const [title, status, detail] of [
      [
        '악보 파일을 컨테이너 외부 영구 볼륨에 저장',
        '적용됨',
        '컨테이너 교체와 파일 저장 수명을 분리합니다.',
      ],
      ['중앙 통합 로그인 계정을 자동 연결', '적용됨', '로컬 비밀번호 기능은 닫혀 있습니다.'],
      ['S3 호환 저장소로 확장', '선택', '현재 로컬 볼륨 운영의 필수 조건이 아닙니다.'],
      ['FeelMyRythm SMTP', '불필요', '중앙 SSO가 책임지므로 앱 SMTP를 설정하지 않습니다.'],
      [
        '서버 악보 볼륨 별도 백업',
        '권장',
        'S3 사용 여부와 관계없는 권장 운영 항목이며, 현재 서비스 사용을 막지 않습니다.',
      ],
      ['모바일 HTTPS 연결 파일 검증', '출시 시', '별도 중앙 SSO bridge 구현 전까지 보류합니다.'],
      ['Audiveris OMR 운영 의존성', '활성화 시', 'OMR 초안 기능을 제공할 때만'],
    ] as const) {
      const item = within(dialog).getByText(title).closest('li');
      expect(item).not.toBeNull();
      expect(within(item as HTMLLIElement).getByText(status)).toBeVisible();
      expect(item).toHaveTextContent(detail);
    }

    fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));
    expect(screen.queryByRole('dialog', { name: '현재 운영 구성' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '현재 운영 구성' })).toBeInTheDocument();
  });

  it('does not expose the operations information outside the managed local SSO build', () => {
    render(<TemporaryOperationsNotice enabled={false} />);
    expect(screen.queryByRole('button', { name: '현재 운영 구성 보기' })).not.toBeInTheDocument();
  });
});
