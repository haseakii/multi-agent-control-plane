import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDefinitionSchema, type SessionSettingsSnapshot } from '@control-plane/core';
import {
  openSqliteStorage,
  SqliteSessionSettingsRepository,
  SqliteSessionPresetsRepository,
} from '@control-plane/storage';
import type { SessionSettingsInspection, AgentReadiness } from '@control-plane/acp-runtime';
import { SessionSettingsService } from './session-settings.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const snapshot = (model = 'first', thought = 'low'): SessionSettingsSnapshot => ({
  source: 'config-options',
  options: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: [
        { value: 'first', name: 'First' },
        { value: 'second', name: 'Second' },
      ],
    },
    {
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: thought,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
});
function fixture() {
  let now = Date.parse('2026-10-25T00:00:00Z');
  let readiness: AgentReadiness = {
    runtime: 'ready',
    auth: 'ready',
    observedAt: new Date(now).toISOString(),
    authMethodIds: ['managed-login'],
  };
  const storage = openSqliteStorage({ filename: ':memory:' });
  cleanup.push(() => storage.close());
  const repository = new SqliteSessionSettingsRepository(storage.sqlite);
  const agents = new Map(
    ['one', 'two'].map((id) => [
      id,
      AgentDefinitionSchema.parse({
        id,
        name: id,
        enabled: true,
        runtime: { type: 'acp-stdio', command: 'fixture-agent', args: [] },
        auth: { mode: 'agent-managed' },
        capabilities: [],
        orchestration: { canBeBoss: true },
        controlBridge: { transport: 'none', scopes: [] },
      }),
    ]),
  );
  const inspect = vi.fn(async (_agent: unknown, _cwd: string, values: Record<string, string>) => ({
    settings: snapshot(values.model, values.thinking),
    observation: {
      source: 'acp-session-new' as const,
      observedAt: new Date(now).toISOString(),
      sessionIdHash: 'd'.repeat(64),
    },
  }));
  const service = new SessionSettingsService(
    repository,
    {
      agent: (id) => agents.get(id)!,
      readiness: () => readiness,
      cwd: (projectId) => '/private/' + (projectId ?? 'empty'),
      inspect,
    },
    { presets: new SqliteSessionPresetsRepository(storage.sqlite), now: () => now },
  );
  return {
    service,
    repository,
    inspect,
    agents,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    checkAgain: (auth: AgentReadiness['auth'] = 'ready') => {
      now++;
      readiness = { ...readiness, auth, observedAt: new Date(now).toISOString() };
    },
  };
}
describe('shared session settings', () => {
  it('opens read-only, probes explicitly, validates confirmed defaults and isolates members', async () => {
    const { service, inspect } = fixture();
    expect(service.read('one').settings).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    await service.inspect('one', undefined, { model: 'second', thinking: 'high' });
    expect(() =>
      service.saveDefaults('one', { expectedRevision: 0, values: { model: 'first' } }),
    ).toThrow('真实可用');
    expect(
      service.saveDefaults('one', {
        expectedRevision: 0,
        values: { model: 'second', thinking: 'high' },
      }).revision,
    ).toBe(1);
    expect(service.read('two').defaults.values).toEqual({});
    expect(() =>
      service.saveDefaults('one', { expectedRevision: 0, values: { model: 'second' } }),
    ).toThrow('已变化');
  });
  it('freezes accepted values and inherits actual confirmed settings across sessions and default changes', async () => {
    const { service, repository } = fixture();
    repository.saveDefaults('one', 0, { model: 'first' });
    service.prepare('parent', 'one', { model: 'second', thinking: 'high' });
    repository.putTask({
      ...repository.getTask('parent')!,
      state: 'applied',
      confirmed: snapshot('second', 'high'),
    });
    repository.saveDefaults('one', 1, { model: 'first', thinking: 'low' });
    service.prepare('followup', 'one', undefined, 'parent');
    expect(repository.getTask('followup')?.requested).toEqual({
      model: 'second',
      thinking: 'high',
    });
    service.prepare('followup', 'one', { model: 'first' });
    expect(repository.getTask('followup')?.requested.model).toBe('second');
    service.prepare('reset', 'one', {}, 'parent');
    expect(repository.getTask('reset')?.requested).toEqual({});
    service.prepare('other', 'two', undefined, 'parent');
    expect(repository.getTask('other')?.requested).toEqual({});
    expect(() => service.prepare('followup', 'two')).toThrow('另一位成员');
  });
  it('invalidates stale definitions, avoids overlapping probes and hides provider exception text', async () => {
    const { service, inspect, agents } = fixture();
    await service.inspect('one');
    agents.set('one', { ...agents.get('one')!, name: 'Changed' });
    expect(service.read('one')).toMatchObject({
      freshness: 'stale',
      staleReason: 'definition-changed',
    });
    let finish!: (v: SessionSettingsInspection) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const active = service.inspect('one');
    await expect(service.inspect('one')).rejects.toThrow('正在读取');
    finish({
      settings: snapshot(),
      observation: {
        source: 'acp-session-new',
        observedAt: '2026-10-25T00:00:00Z',
        sessionIdHash: 'd'.repeat(64),
      },
    });
    await active;
    inspect.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_DETAIL'));
    await expect(service.inspect('one')).rejects.toThrow('未能读取');
    expect(service.read('one').defaults.values).toEqual({});
  });
  it('expires only capability observations and invalidates changed readiness evidence without probing on read', async () => {
    const { service, repository, inspect, advance, checkAgain } = fixture();
    expect(service.read('one')).toMatchObject({ freshness: 'unavailable', observation: null });
    const observed = await service.inspect('one', undefined, { model: 'second' });
    expect(observed).toMatchObject({
      freshness: 'fresh',
      observation: {
        source: 'acp-session-new',
        accountIdentity: 'not-exposed',
        sessionIdHash: 'd'.repeat(64),
      },
    });
    service.prepare('history', 'one', { model: 'second' });
    repository.putTask({
      ...repository.getTask('history')!,
      state: 'applied',
      confirmed: snapshot('second'),
    });
    advance(300_000);
    expect(service.read('one')).toMatchObject({ freshness: 'stale', staleReason: 'expired' });
    expect(service.read('one').settings).toEqual(observed.settings);
    expect(() => service.saveDefaults('one', { expectedRevision: 0, values: {} })).toThrow(
      '重新读取',
    );
    expect(repository.getTask('history')?.confirmed).toEqual(snapshot('second'));
    expect(inspect).toHaveBeenCalledTimes(1);
    await service.inspect('one', undefined, { model: 'second' });
    checkAgain('needs_login');
    expect(service.read('one')).toMatchObject({
      freshness: 'stale',
      staleReason: 'readiness-changed',
    });
    expect(() =>
      service.saveDefaults('one', { expectedRevision: 0, values: { model: 'second' } }),
    ).toThrow('重新读取');
  });
  it('requires fresh confirmed values for presets, while rename/archive/list stay offline and copied task values stay frozen', async () => {
    const { service, inspect, advance, repository } = fixture();
    const id = '358457e5-8e5c-458f-98c4-c55054e828e4';
    const input = { id, name: 'Daily', values: { model: 'second' } };
    expect(() => service.createPreset('one', input)).toThrow('重新读取');
    await service.inspect('one', undefined, input.values);
    const created = service.createPreset('one', input);
    service.prepare('task-copy', 'one', created.values);
    advance(300_001);
    const renamed = service.updatePreset('one', id, {
      expectedRevision: created.revision,
      name: 'Renamed',
    });
    expect(renamed.values).toEqual(input.values);
    expect(() =>
      service.updatePreset('one', id, { expectedRevision: renamed.revision, values: input.values }),
    ).toThrow('重新读取');
    const archived = service.archivePreset('one', id, { expectedRevision: renamed.revision });
    expect(service.listPresets('one').presets).toEqual([]);
    expect(service.listPresets('one', true).presets).toHaveLength(1);
    const restored = service.archivePreset(
      'one',
      id,
      { expectedRevision: archived.revision },
      true,
    );
    expect(restored.archived).toBe(false);
    expect(() =>
      service.updatePreset('one', id, { expectedRevision: created.revision, name: 'Stale' }),
    ).toThrow('已在其他位置');
    expect(repository.getTask('task-copy')?.requested).toEqual(input.values);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('copies preset identity and values once so a later archive cannot change retry settings', async () => {
    const { service, repository } = fixture();
    const id = '478b1295-e87a-43a2-8de2-37c277de106a';
    await service.inspect('one', undefined, { model: 'second' });
    const preset = service.createPreset('one', {
      id,
      name: 'Original',
      values: { model: 'second' },
    });
    const lookup = vi.spyOn(service, 'getPreset');
    service.prepare('accepted', 'one', undefined, undefined, id);
    const frozen = repository.getTask('accepted')!;
    expect(frozen).toMatchObject({
      requested: preset.values,
      selectedPreset: { id, revision: 1, name: 'Original' },
    });
    service.updatePreset('one', id, { expectedRevision: 1, name: 'Later' });
    service.archivePreset('one', id, { expectedRevision: 2 });
    service.prepare('accepted', 'one', undefined, undefined, id);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(repository.getTask('accepted')).toEqual(frozen);
    expect(() => service.prepare('new-task', 'one', undefined, undefined, id)).toThrow('已归档');
    expect(() => service.prepare('invalid', 'one', {}, undefined, id)).toThrow('不能同时');
  });
});
