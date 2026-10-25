import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDefinitionSchema, type SessionSettingsSnapshot } from '@control-plane/core';
import { openSqliteStorage, SqliteSessionSettingsRepository } from '@control-plane/storage';
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
  const inspect = vi.fn(async (_agent: unknown, _cwd: string, values: Record<string, string>) =>
    snapshot(values.model, values.thinking),
  );
  const service = new SessionSettingsService(repository, {
    agent: (id) => agents.get(id)!,
    cwd: (projectId) => '/private/' + (projectId ?? 'empty'),
    inspect,
  });
  return { service, repository, inspect, agents };
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
    expect(service.read('one').settings).toBeNull();
    let finish!: (v: SessionSettingsSnapshot) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const active = service.inspect('one');
    await expect(service.inspect('one')).rejects.toThrow('正在读取');
    finish(snapshot());
    await active;
    inspect.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_DETAIL'));
    await expect(service.inspect('one')).rejects.toThrow('未能读取');
    expect(service.read('one').defaults.values).toEqual({});
  });
});
