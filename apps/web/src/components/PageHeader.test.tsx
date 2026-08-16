import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('announces a lazy route after its heading mounts', () => {
    render(<PageHeader eyebrow="Test" title="반응형 화면" description="설명" />);

    const heading = screen.getByRole('heading', { name: '반응형 화면', level: 1 });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveFocus();
    expect(document.title).toBe('반응형 화면 · FeelMyRythm');
  });
});
