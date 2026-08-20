import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TemporaryOperationsNotice, temporaryOperationsTasks } from './TemporaryOperationsNotice';

describe('TemporaryOperationsNotice', () => {
  afterEach(cleanup);

  it('opens automatically and remains available from the top-bar trigger', () => {
    render(<TemporaryOperationsNotice enabled />);

    const dialog = screen.getByRole('dialog', { name: '임시 운영 할 일' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(temporaryOperationsTasks.length);
    expect(within(dialog).getByText('AWS S3를 준비하고 로컬 악보 파일 이관')).toBeVisible();
    expect(within(dialog).getByText('SMTP 발송 도메인과 키 설정')).toBeVisible();
    expect(within(dialog).getByText('서버에서 만든 단일 계정만 로그인')).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: '확인하고 둘러보기' }));
    expect(screen.queryByRole('dialog', { name: '임시 운영 할 일' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '임시 운영 할 일' }));
    expect(screen.getByRole('dialog', { name: '임시 운영 할 일' })).toBeInTheDocument();
  });

  it('does not expose the temporary notice outside the temporary build', () => {
    render(<TemporaryOperationsNotice enabled={false} />);
    expect(screen.queryByRole('button', { name: '임시 운영 할 일' })).not.toBeInTheDocument();
  });
});
