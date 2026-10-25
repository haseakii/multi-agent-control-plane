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
it('preserves uploaded attachment identities across a lost receipt and never reuses a key for a changed selection', () => {
  const f = fixture(),
    a = '11111111-1111-4111-8111-111111111111',
    b = '22222222-2222-4222-8222-222222222222';
  const first = f.reload().prepare('c', ['first'], 'first', 'Read this', undefined, [a]);
  const retry = f.reload().prepare('c', ['first', 'second'], 'second', 'Read this', undefined, [a]);
  expect(retry.request).toEqual(first.request);
  expect(retry.reused).toBe(true);
  const changed = f
    .reload()
    .prepare('c', ['first', 'second'], 'second', 'Read this', undefined, [b]);
  expect(changed.reused).toBe(false);
  expect(changed.request.key).not.toBe(first.request.key);
  expect(changed.request.attachmentIds).toEqual([b]);
});
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
it('freezes model settings with the pending prompt across reload and new conversation rounds', () => {
  const f = fixture();
  const original = f
    .reload()
    .prepare('a', ['one'], 'one', 'Keep working', { model: 'model-a', effort: 'high' });
  const retry = f
    .reload()
    .prepare('a', ['one', 'two'], 'two', 'Keep working', { effort: 'high', model: 'model-a' });
  expect(retry).toMatchObject({ reused: true, request: original.request });
  expect(retry.request.sessionSettings).toEqual({ model: 'model-a', effort: 'high' });
});
it('does not reuse an idempotency key when the next prompt changes its model settings', () => {
  const f = fixture();
  const original = f.reload().prepare('a', ['one'], 'one', 'Keep working', { model: 'model-a' });
  const changed = f
    .reload()
    .prepare('a', ['one', 'two'], 'two', 'Keep working', { model: 'model-b' });
  expect(changed.reused).toBe(false);
  expect(changed.request.key).not.toBe(original.request.key);
  expect(changed.request.sessionSettings).toEqual({ model: 'model-b' });
  const inherited = f.reload().prepare('a', ['one', 'two'], 'two', 'Keep working');
  expect(inherited.reused).toBe(false);
  expect(inherited.request.sessionSettings).toBeUndefined();
});
