import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel, type ApprovalItem } from './approval-panel';

// A hook-only renderer: no DOM, server, transport, ACP or decision implementation.
// Every callback below is an inert spy or a manually settled local Promise.
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  let writes = 0;
  let effects: (() => void | (() => void))[] = [];
  const cleanups: (() => void)[] = [];
  return {
    reset() {
      slots.length = 0;
      cursor = 0;
      effects = [];
      cleanups.length = 0;
      writes = 0;
    },
    begin() {
      cursor = 0;
    },
    writes() {
      return writes;
    },
    commit() {
      for (const effect of effects.splice(0)) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
    },
    unmount() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (value: unknown) => {
          writes++;
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++,
        previous = slots[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        slots[index] = deps;
        effects.push(effect);
      }
    },
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...elements(value.props.children)];
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const approval = (id: string): ApprovalItem => ({
  id,
  projectId: 'synthetic-project',
  taskId: 'synthetic-task-' + id,
  action: 'acp.tool',
  resource: {},
  state: 'pending',
  enforcementMode: 'cooperative',
  decisionEligibility: {
    canApprove: true,
    canReject: true,
    reason: 'current_complete',
    checkedAt: '2026-10-21T00:00:00Z',
    validForMs: 3000,
  },
});
function fixture() {
  const a = deferred(),
    b = deferred();
  const onRefresh = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const onDecision = vi.fn(async () => {}); // No execution or network capability.
  let props = {
    approvals: [approval('a'), approval('b')],
    visibleIds: ['a', 'b'],
    diagnostics: undefined,
    healthy: true,
    startedAt: performance.now(),
    busy: false,
    onRefresh,
    onDecision,
  };
  const render = () => {
    hooks.begin();
    const tree = ApprovalPanel(props);
    hooks.commit();
    return tree;
  };
  const review = () =>
    elements(render()).find(
      (element) => typeof element.type === 'function' && element.type.name === 'ApprovalReview',
    );
  const open = (id: string) => {
    const trigger = elements(render()).find(
      (element) => element.props['data-approval-trigger'] === id,
    )!;
    (trigger.props.onClick as () => void)();
    return review()!;
  };
  return {
    a,
    b,
    onRefresh,
    onDecision,
    render,
    review,
    open,
    scope(ids: string[]) {
      props = { ...props, visibleIds: ids };
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  hooks.reset();
  vi.stubGlobal('window', {
    setInterval: () => 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('clearInterval', () => {});
  vi.stubGlobal('requestAnimationFrame', () => 0);
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
});

describe('approval selection and refresh ownership (inert local state only)', () => {
  it('closes details immediately when selected approval leaves visible task scope', () => {
    const f = fixture();
    f.open('a');
    f.scope(['b']);
    expect(f.review()).toBeUndefined();
  });
  it('rechecks latest task scope before invoking even a stale captured callback', async () => {
    const f = fixture();
    const old = f.open('a');
    f.a.resolve();
    await settle();
    const handler = f.review()!.props.onDecision as (decision: string) => void;
    f.scope(['b']);
    f.render();
    handler('approve');
    await settle();
    expect(f.onDecision).not.toHaveBeenCalled();
    expect(old.props.approval).toMatchObject({ id: 'a' });
  });
  it.each(['resolve', 'reject'] as const)(
    'old A %s does not unlock the pending B refresh',
    async (outcome) => {
      const f = fixture();
      const first = f.open('a');
      (first.props.onClose as () => void)();
      f.render();
      f.open('b');
      if (outcome === 'resolve') f.a.resolve();
      else f.a.reject(new Error('local obsolete refresh'));
      await settle();
      expect(f.review()!.props.availability).toMatchObject({ canApprove: false, canReject: false });
      f.b.resolve();
      await settle();
      expect(f.review()!.props.availability).toMatchObject({ canApprove: true, canReject: true });
      expect(f.onDecision).not.toHaveBeenCalled();
    },
  );
  it('old A cannot unlock a reopened A with a different refresh generation', async () => {
    const f = fixture();
    const first = f.open('a');
    (first.props.onClose as () => void)();
    f.render();
    f.open('a');
    f.a.resolve();
    await settle();
    expect(f.review()!.props.availability).toMatchObject({ canApprove: false, canReject: false });
    f.b.resolve();
    await settle();
    expect(f.review()!.props.availability).toMatchObject({ canApprove: true, canReject: true });
  });
  it('does not invoke a stale decision callback after closing and reopening the same ID', async () => {
    const f = fixture();
    f.open('a');
    f.a.resolve();
    await settle();
    const first = f.review()!;
    (first.props.onClose as () => void)();
    f.render();
    f.open('a');
    f.b.resolve();
    await settle();
    (first.props.onDecision as (decision: string) => void)('approve');
    await settle();
    expect(f.onDecision).not.toHaveBeenCalled();
  });
  it('cannot reopen an out-of-scope approval through a stale list callback', () => {
    const f = fixture();
    const trigger = elements(f.render()).find(
      (element) => element.props['data-approval-trigger'] === 'a',
    )!;
    f.scope(['b']);
    f.render();
    (trigger.props.onClick as () => void)();
    expect(f.review()).toBeUndefined();
    expect(f.onRefresh).not.toHaveBeenCalled();
  });
  it('unmount invalidates outstanding refresh settlements without further state writes', async () => {
    const f = fixture();
    f.open('a');
    hooks.unmount();
    const writes = hooks.writes();
    f.a.resolve();
    await settle();
    expect(hooks.writes()).toBe(writes);
    expect(f.onDecision).not.toHaveBeenCalled();
  });
});
