import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from './main';

describe('secure application bootstrap', () => {
  it('never loads App when the PWA security transition fails and shows recovery UI', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const establishPwaRuntime = vi.fn().mockRejectedValue(new Error('unsafe legacy worker'));
    const loadApp = vi.fn(async () => ({ App: () => <div>App mounted</div> }));
    const reload = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await bootstrap({ establishPwaRuntime, loadApp, pwaEnabled: true, reload });

    expect(loadApp).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('alert', { name: '보안 업데이트를 완료하지 못했습니다' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('App mounted')).not.toBeInTheDocument();
    screen.getByRole('button', { name: '다시 확인' }).click();
    expect(reload).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
