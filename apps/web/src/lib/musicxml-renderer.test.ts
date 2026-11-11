import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMusicXml } from './musicxml';

const osmd = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('opensheetmusicdisplay', () => ({
  OpenSheetMusicDisplay: class {
    constructor(...args: unknown[]) {
      return osmd.create(...args) as object;
    }
  },
}));

let resize: () => void;
let width: number;
let frames: Map<number, FrameRequestCallback>;
const disconnect = vi.fn();

beforeEach(() => {
  osmd.create.mockReset();
  disconnect.mockClear();
  width = 800;
  frames = new Map();
  let frameId = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
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
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeRenderer(load: (xml: string) => Promise<void> = async () => undefined) {
  return { load: vi.fn(load), render: vi.fn(), clear: vi.fn() };
}

describe('MusicXML rendering lifetime', () => {
  it('owns width-only resize work and releases the observer, frame and sheet on abort', async () => {
    const renderer = makeRenderer();
    osmd.create.mockReturnValue(renderer);
    const container = document.createElement('div');
    const controller = new AbortController();
    await renderMusicXml(container, '<score/>', controller.signal, vi.fn());
    expect(osmd.create).toHaveBeenCalledWith(
      container.firstElementChild,
      expect.objectContaining({ autoResize: false }),
    );
    expect(renderer.render).toHaveBeenCalledTimes(1);
    resize();
    expect(frames.size).toBe(0);
    width = 400;
    resize();
    width = 500;
    resize();
    expect(frames.size).toBe(1);
    const [id, callback] = [...frames][0]!;
    frames.delete(id);
    callback(0);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    width = 300;
    resize();
    controller.abort();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(renderer.clear).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  });

  it('cannot overwrite a new score when an aborted load completes late', async () => {
    let finish!: () => void;
    const old = makeRenderer(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const current = makeRenderer();
    osmd.create.mockReturnValueOnce(old).mockReturnValueOnce(current);
    const container = document.createElement('div');
    const first = new AbortController();
    const oldLoad = renderMusicXml(container, 'old', first.signal, vi.fn());
    await vi.waitFor(() => expect(old.load).toHaveBeenCalled());
    first.abort();
    const second = new AbortController();
    await renderMusicXml(container, 'new', second.signal, vi.fn());
    const surface = container.firstElementChild;
    finish();
    await oldLoad;
    expect(old.render).not.toHaveBeenCalled();
    expect(current.render).toHaveBeenCalledTimes(1);
    expect(container.firstElementChild).toBe(surface);
    expect(old.clear).toHaveBeenCalledTimes(2);
    second.abort();
  });

  it('does not construct a renderer for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await renderMusicXml(document.createElement('div'), 'old', controller.signal, vi.fn());
    expect(osmd.create).not.toHaveBeenCalled();
  });

  it('releases a failed load and reports resize rendering failures', async () => {
    const failed = makeRenderer(
      vi.fn(async () => {
        throw new Error('invalid XML');
      }),
    );
    osmd.create.mockReturnValueOnce(failed);
    const controller = new AbortController();
    const container = document.createElement('div');
    await expect(renderMusicXml(container, 'invalid', controller.signal, vi.fn())).rejects.toThrow(
      'invalid XML',
    );
    expect(failed.clear).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
    const renderer = makeRenderer();
    osmd.create.mockReturnValueOnce(renderer);
    const onError = vi.fn();
    await renderMusicXml(container, 'valid', controller.signal, onError);
    renderer.render.mockImplementationOnce(() => {
      throw new Error('resize failed');
    });
    width = 400;
    resize();
    [...frames.values()][0]!(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'resize failed' }));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  });
});
