import { expect, it } from 'vitest';
import { createComposerDrafts } from '../src/composer-drafts';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, text: string) => {
      values.set(key, text);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

it('restores separate goal and conversation drafts after a page reload, including intentionally empty input', () => {
  const store = storage();
  const drafts = createComposerDrafts(() => store);
  drafts.write('goal', '完整目标');
  drafts.write('followup-1', '继续修改');
  drafts.write('followup-2', '');
  const reloaded = createComposerDrafts(() => store);
  expect(reloaded.read('goal')).toEqual({ text: '完整目标', persisted: true });
  expect(reloaded.read('followup-1').text).toBe('继续修改');
  expect(reloaded.read('followup-2').text).toBe('');
});

it('retains current input across in-page navigation when browser storage is blocked', () => {
  const drafts = createComposerDrafts(() => {
    throw Error('SecurityError');
  });
  expect(drafts.read('goal')).toEqual({ text: null, persisted: false });
  expect(drafts.write('goal', '不能丢失的最新输入').persisted).toBe(false);
  expect(drafts.read('goal').text).toBe('不能丢失的最新输入');
  drafts.clear('goal');
  expect(drafts.read('goal').text).toBeNull();
});

it('quota failures retain newest text, discard stale disk copy and recover on later writes', () => {
  const store = storage();
  store.setItem('goal', '旧文本');
  let full = true;
  const drafts = createComposerDrafts(() => ({
    ...store,
    setItem: (key, value) => {
      if (full) throw Error('QuotaExceededError');
      store.setItem(key, value);
    },
  }));
  expect(drafts.read('goal').text).toBe('旧文本');
  expect(drafts.write('goal', '新文本').persisted).toBe(false);
  expect(store.getItem('goal')).toBeNull();
  expect(drafts.read('goal').text).toBe('新文本');
  full = false;
  expect(drafts.write('goal', '新文本').persisted).toBe(true);
  expect(createComposerDrafts(() => store).read('goal').text).toBe('新文本');
});

it('failed cleanup after a successful send never throws or restores old text in the same page', async () => {
  const store = storage();
  store.setItem('goal', '已发送');
  const drafts = createComposerDrafts(() => ({
    ...store,
    removeItem: () => {
      throw Error('blocked');
    },
  }));
  await expect(
    (async () => {
      const result = await Promise.resolve({ taskId: 'accepted' });
      drafts.clear('goal');
      return result;
    })(),
  ).resolves.toEqual({ taskId: 'accepted' });
  expect(drafts.read('goal').text).toBeNull();
});
