import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactPreviewLoader, type PreviewSnapshot } from '../src/artifact-previews';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const source = (id: string, sha256 = 'a'.repeat(64)) => ({ id, sha256 });
function fixture(read: (id: string, signal: AbortSignal) => Promise<string>) {
  let state: PreviewSnapshot = { content: {}, errors: {} };
  const loader = new ArtifactPreviewLoader(read, (next) => {
    state = next;
  });
  return { loader, state: () => state };
}

it('does not await a slow preview, deduplicates polls and keeps another result visible', async () => {
  const slow = deferred();
  const read = vi.fn(async (id: string) => (id === 'slow' ? slow.promise : '协作结果'));
  const f = fixture(read);
  expect(f.loader.synchronize('task-a', [source('slow'), source('result')])).toBeUndefined();
  await vi.advanceTimersByTimeAsync(0);
  f.loader.synchronize('task-a', [source('slow'), source('result')]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(f.state().content).toEqual({ result: '协作结果' });
  slow.resolve('稍后到达');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state().content.slow).toBe('稍后到达');
  f.loader.dispose();
});

it('cancels the old task and ignores its late response even if the transport ignores abort', async () => {
  const old = deferred();
  const signals: AbortSignal[] = [];
  const f = fixture(async (_id, signal) => {
    signals.push(signal);
    return signals.length === 1 ? old.promise : '新任务结果';
  });
  f.loader.synchronize('task-a', [source('shared-id')]);
  await vi.advanceTimersByTimeAsync(0);
  f.loader.synchronize('task-b', [source('shared-id')]);
  await vi.advanceTimersByTimeAsync(0);
  expect(signals[0]!.aborted).toBe(true);
  old.resolve('旧任务结果');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state().content).toEqual({ 'shared-id': '新任务结果' });
  f.loader.dispose();
});

it('invalidates a previous content hash and never lets it replace the newer preview', async () => {
  const old = deferred();
  const f = fixture(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('新版内容'));
  f.loader.synchronize('task-a', [source('artifact')]);
  await vi.advanceTimersByTimeAsync(0);
  f.loader.synchronize('task-a', [source('artifact', 'b'.repeat(64))]);
  await vi.advanceTimersByTimeAsync(0);
  old.resolve('旧版内容');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state().content.artifact).toBe('新版内容');
  f.loader.dispose();
});

it('expires only its own preview, retries explicitly and ignores a late expired response', async () => {
  const late = deferred();
  const read = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue('重读成功');
  const f = fixture(read);
  f.loader.synchronize('task-a', [source('artifact')]);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.state().errors.artifact).toContain('超时');
  f.loader.synchronize('task-a', [source('artifact')]);
  expect(read).toHaveBeenCalledTimes(1);
  f.loader.retry('artifact');
  await vi.advanceTimersByTimeAsync(0);
  late.resolve('迟到内容');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.state()).toEqual({ content: { artifact: '重读成功' }, errors: {} });
  f.loader.dispose();
});

it('keeps a per-item failure separate and discards callbacks after disposal', async () => {
  const pending = deferred();
  const changed = vi.fn();
  const read = vi.fn(async (id: string) => {
    if (id === 'missing') throw Error('HTTP 404');
    if (id === 'pending') return pending.promise;
    return '';
  });
  const loader = new ArtifactPreviewLoader(read, changed);
  loader.synchronize('task-a', [source('missing'), source('empty'), source('pending')]);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith({
    content: { empty: '' },
    errors: { missing: 'HTTP 404' },
  });
  loader.dispose();
  changed.mockClear();
  pending.resolve('不应显示');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(changed).not.toHaveBeenCalled();
});
