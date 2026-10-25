import { expect, it } from 'vitest';
import { conversationControlKeys } from '../src/conversation-control-keys';

it('keeps runtime and composer sibling identities distinct when the first task is also the conversation', () => {
  const original = conversationControlKeys('first-task', 'first-task');
  expect(original.runtimeSettings).not.toBe(original.followUpComposer);
  for (let refresh = 0; refresh < 20; refresh++) {
    expect(conversationControlKeys('first-task', 'first-task')).toEqual(original);
  }
});

it('replaces only the runtime card when a follow-up starts, retaining the conversation input identity', () => {
  const first = conversationControlKeys('first-task', 'first-task');
  const followUp = conversationControlKeys('next-task', 'first-task');
  expect(followUp.runtimeSettings).not.toBe(first.runtimeSettings);
  expect(followUp.followUpComposer).toBe(first.followUpComposer);
  expect(
    conversationControlKeys('another-conversation', 'another-conversation').followUpComposer,
  ).not.toBe(first.followUpComposer);
});
