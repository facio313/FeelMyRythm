import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
  it('renders useful Markdown structure without executing raw HTML', () => {
    const { container } = render(
      <MarkdownContent>
        {'# 연습\n\n- 26마디 **crescendo**\n\n<script>alert(1)</script>'}
      </MarkdownContent>,
    );
    expect(screen.getByRole('heading', { name: '연습' })).toBeInTheDocument();
    expect(screen.getByText('crescendo').tagName).toBe('STRONG');
    expect(container.querySelector('script')).toBeNull();
  });

  it('drops unsafe link protocols', () => {
    render(<MarkdownContent>{'[unsafe](javascript:alert(1))'}</MarkdownContent>);
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull();
    expect(screen.getByText('unsafe')).toBeInTheDocument();
  });
});
