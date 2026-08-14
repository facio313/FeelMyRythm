import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionPage } from './AccountDeletionPage';
import { PrivacyPage } from './PrivacyPage';

const authState = vi.hoisted(() => ({ user: null as null | { id: string } }));

vi.mock('../lib/auth', () => ({ useAuth: () => authState }));

afterEach(cleanup);

beforeEach(() => {
  authState.user = null;
});

describe('public legal pages', () => {
  it('publishes privacy contact, microphone handling, retention, and deletion information', () => {
    render(
      <MemoryRouter>
        <PrivacyPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '개인정보 처리 안내' })).toBeInTheDocument();
    expect(screen.getByText(/원본 오디오를 서버로 전송하거나 저장하지 않습니다/)).toBeVisible();
    expect(screen.getByRole('link', { name: /privacy@bonifacio.work/ })).toHaveAttribute(
      'href',
      'mailto:privacy@bonifacio.work',
    );
    expect(screen.getByRole('link', { name: /계정 삭제 안내 열기/ })).toHaveAttribute(
      'href',
      '/delete-account',
    );
  });

  it('returns signed-out users to the public deletion resource after login', () => {
    render(
      <MemoryRouter initialEntries={['/delete-account']}>
        <Routes>
          <Route path="delete-account" element={<AccountDeletionPage />} />
          <Route path="login" element={<div>로그인 화면</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '로그인하고 삭제 계속하기' }));
    expect(screen.getByText('로그인 화면')).toBeInTheDocument();
  });

  it('sends signed-in users directly to account settings', () => {
    authState.user = { id: 'user-1' };
    render(
      <MemoryRouter initialEntries={['/delete-account']}>
        <Routes>
          <Route path="delete-account" element={<AccountDeletionPage />} />
          <Route path="settings" element={<div>계정 설정 화면</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '계정 설정에서 삭제 계속하기' }));
    expect(screen.getByText('계정 설정 화면')).toBeInTheDocument();
  });
});
