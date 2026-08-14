import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, Field, StatusBadge } from '../src';

describe('UI primitives', () => {
  it('keeps controls labelled and keyboard reachable', () => {
    render(
      <>
        <Field label="BPM" type="number" />
        <Button>재생</Button>
        <StatusBadge tone="success">동기화됨</StatusBadge>
      </>,
    );
    expect(screen.getByLabelText('BPM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '재생' })).toBeEnabled();
    expect(screen.getByText('동기화됨')).toBeInTheDocument();
  });

  it('assigns unique ids when labels contain no ASCII characters', () => {
    render(
      <>
        <Field label="이메일" />
        <Field label="비밀번호" type="password" hint="8자 이상" />
      </>,
    );
    const email = screen.getByLabelText('이메일');
    const password = screen.getByLabelText(/^비밀번호/);
    expect(email).not.toBe(password);
    expect(email.id).not.toBe(password.id);
  });
});
