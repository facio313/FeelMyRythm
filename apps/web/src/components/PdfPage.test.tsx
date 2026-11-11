import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfPage } from './PdfPage';

const getDocument = vi.hoisted(() => vi.fn());
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function makePage() {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  };
}

function makeBlob() {
  const blob = new Blob(['pdf']);
  const read = vi.fn(async () => new ArrayBuffer(3));
  Object.defineProperty(blob, 'arrayBuffer', { value: read });
  return { blob, read };
}

let width: number;
let resize: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  getDocument.mockReset();
  disconnect.mockClear();
  width = 800;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.stubGlobal('devicePixelRatio', 2);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PDF document lifetime', () => {
  it('reads and loads once across page, callback, width and pixel-density changes', async () => {
    const file = makeBlob();
    const page = makePage();
    const pdf = { numPages: 4, getPage: vi.fn(async () => page) };
    const destroy = vi.fn(async () => undefined);
    getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy });
    const count = vi.fn();
    const view = render(<PdfPage blob={file.blob} pageNumber={1} onPageCount={count} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    expect(count).toHaveBeenCalledWith(4);
    expect(page.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ transform: [2, 0, 0, 2, 0, 0] }),
    );
    view.rerender(<PdfPage blob={file.blob} pageNumber={2} onPageCount={vi.fn()} />);
    await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(2));
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(2));
    act(() => resize());
    expect(page.render).toHaveBeenCalledTimes(2);
    act(() => {
      width = 400;
      resize();
    });
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(3));
    expect(view.container.querySelector('canvas')?.width).toBe(800);
    act(() => {
      vi.stubGlobal('devicePixelRatio', 1);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(4));
    expect(view.container.querySelector('canvas')?.width).toBe(400);
    expect(file.read).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    view.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending render before reusing the canvas, without displaying an error', async () => {
    const page = makePage();
    const pending = deferred<void>();
    const cancel = vi.fn(() => pending.reject(new Error('render cancelled')));
    page.render.mockReturnValueOnce({ promise: pending.promise, cancel });
    getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage: async () => page }),
      destroy: vi.fn(async () => undefined),
    });
    const { blob } = makeBlob();
    const count = vi.fn();
    const view = render(<PdfPage blob={blob} pageNumber={1} onPageCount={count} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    view.rerender(<PdfPage blob={blob} pageNumber={2} onPageCount={count} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(page.cleanup).toHaveBeenCalledTimes(2);
  });

  it('does not draw an obsolete page that finishes loading after navigation', async () => {
    const oldPage = makePage();
    const currentPage = makePage();
    const pending = deferred<ReturnType<typeof makePage>>();
    const getPage = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(currentPage);
    getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2, getPage }),
      destroy: vi.fn(async () => undefined),
    });
    const { blob } = makeBlob();
    const count = vi.fn();
    const view = render(<PdfPage blob={blob} pageNumber={1} onPageCount={count} />);
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
    view.rerender(<PdfPage blob={blob} pageNumber={2} onPageCount={count} />);
    await waitFor(() => expect(currentPage.render).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve(oldPage));
    expect(oldPage.render).not.toHaveBeenCalled();
    expect(oldPage.cleanup).toHaveBeenCalledTimes(1);
  });

  it('destroys a replaced loading document and ignores its late completion', async () => {
    const page = makePage();
    const pdf = { numPages: 2, getPage: vi.fn(async () => page) };
    const pending = deferred<typeof pdf>();
    const destroyOld = vi.fn(async () => undefined);
    const destroyNew = vi.fn(async () => undefined);
    getDocument
      .mockReturnValueOnce({ promise: pending.promise, destroy: destroyOld })
      .mockReturnValueOnce({ promise: Promise.resolve(pdf), destroy: destroyNew });
    const count = vi.fn();
    const view = render(<PdfPage blob={makeBlob().blob} pageNumber={1} onPageCount={count} />);
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    view.rerender(<PdfPage blob={makeBlob().blob} pageNumber={1} onPageCount={count} />);
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve(pdf));
    expect(destroyOld).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(page.render).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(destroyNew).toHaveBeenCalledTimes(1);
  });

  it('releases a failed document and reloads on an explicit retry', async () => {
    const destroy = vi.fn(async () => undefined);
    const page = makePage();
    getDocument
      .mockImplementationOnce(() => ({
        promise: Promise.reject(new Error('invalid PDF')),
        destroy,
      }))
      .mockImplementationOnce(() => ({
        promise: Promise.resolve({ numPages: 1, getPage: async () => page }),
        destroy: vi.fn(async () => undefined),
      }));
    const file = makeBlob();
    render(<PdfPage blob={file.blob} pageNumber={1} onPageCount={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid PDF');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    expect(file.read).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
