import { expect, it } from 'vitest';
import { createComposerDrafts } from '../src/composer-drafts';
import { createFollowUpSubmissions } from '../src/followup-submissions';
function fixture() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  let serial = 0;
  const newKey = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const reload = () =>
    createFollowUpSubmissions(
      createComposerDrafts(() => storage),
      newKey,
    );
  return { reload };
}
it('reuses the original target and key after reload even if a newer round has appeared', () => {
  const f = fixture();
  const sent = f.reload().prepare('conversation', ['first'], 'first', '  Make it blue  ');
  const recovered = f
    .reload()
    .prepare('conversation', ['first', 'second'], 'second', 'Make it blue');
  expect(recovered).toMatchObject({ request: sent.request, reused: true, persisted: true });
  expect(recovered.request.taskId).toBe('first');
});
it('keeps conversations separate and creates a new key after confirmed receipt', () => {
  const f = fixture();
  const outbox = f.reload();
  const first = outbox.prepare('a', ['one'], 'one', 'Same text');
  expect(outbox.read('b')).toBeUndefined();
  outbox.clear('a');
  expect(f.reload().read('a')).toBeUndefined();
  expect(f.reload().prepare('a', ['one', 'two'], 'two', 'Same text').request.key).not.toBe(
    first.request.key,
  );
});
it('treats changed text as a new explicit instruction rather than reusing its old receipt', () => {
  const f = fixture();
  const outbox = f.reload();
  const first = outbox.prepare('a', ['one'], 'one', 'Blue');
  const next = outbox.prepare('a', ['one', 'two'], 'two', 'Green');
  expect(next).toMatchObject({ reused: false, request: { taskId: 'two', text: 'Green' } });
  expect(next.request.key).not.toBe(first.request.key);
});
it('preserves retry identity within the page if browser storage is unavailable', () => {
  const drafts = createComposerDrafts(() => {
    throw Error('blocked');
  });
  const outbox = createFollowUpSubmissions(drafts, () => crypto.randomUUID());
  const first = outbox.prepare('a', ['one'], 'one', 'Retain changes');
  expect(first.persisted).toBe(false);
  expect(outbox.prepare('a', ['one'], 'one', 'Retain changes')).toMatchObject({
    request: first.request,
    reused: true,
  });
});
