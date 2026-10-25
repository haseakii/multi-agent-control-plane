import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  openSqliteStorage,
  SessionPresetsError,
  SqliteSessionPresetsRepository,
  SqliteSessionSettingsRepository,
} from './index.js';

const at = '2026-10-25T00:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-presets-'));
  const filename = join(root, 'state.sqlite');
  const storage = openSqliteStorage({ filename });
  let tick = 0;
  const clock = () => new Date(Date.parse(at) + tick++ * 1000).toISOString();
  return {
    root,
    filename,
    storage,
    presets: new SqliteSessionPresetsRepository(storage.sqlite, clock),
    close() {
      if (storage.sqlite.open) storage.close();
      removeFixture(root);
    },
  };
}
function removeFixture(root: string) {
  const target = resolve(root);
  if (!relative(resolve(tmpdir()), target).startsWith('session-presets-'))
    throw new Error('Unexpected fixture directory.');
  rmSync(target, { recursive: true, force: true });
}
const expectCode = (run: () => unknown, code: SessionPresetsError['code']) => {
  try {
    run();
    throw new Error('Expected preset operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionPresetsError);
    expect((error as SessionPresetsError).code).toBe(code);
  }
};

it('upgrades sixteen migrations without changing tasks, defaults or approvals and reopens named presets', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-presets-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const old = join(root, 'old');
    mkdirSync(join(old, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 16);
    writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(old, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: old });
    storage.repositories.projects.upsert({
      id: 'p',
      name: 'Preserved project',
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.tasks.upsert({
      id: 'task',
      projectId: 'p',
      title: 'Keep history',
      objective: 'Retain prior context and code changes',
      state: 'completed',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.approvals.upsert({
      id: 'approval',
      projectId: 'p',
      taskId: 'task',
      action: 'git.merge',
      resource: { path: 'page.html' },
      state: 'pending',
      enforcementMode: 'cooperative',
      requestedAt: at,
    });
    const settings = new SqliteSessionSettingsRepository(storage.sqlite);
    settings.saveDefaults('agent', 0, { model: 'original' });
    settings.putTask({
      taskId: 'task',
      agentId: 'agent',
      requested: { model: 'original' },
      state: 'applied',
      confirmed: { source: 'unavailable', options: [] },
    });
    const before = Object.fromEntries(
      ['tasks', 'approvals', 'agent_session_defaults', 'task_session_settings'].map((table) => [
        table,
        storage!.sqlite.prepare(`SELECT * FROM ${table}`).all(),
      ]),
    );
    storage.close();
    storage = openSqliteStorage({ filename });
    for (const [table, rows] of Object.entries(before))
      expect(storage.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    const expectedMigrations = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ).entries.length;
    expect(storage.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: expectedMigrations,
    });
    const presets = new SqliteSessionPresetsRepository(storage.sqlite, () => at);
    const original = presets.create({
      id: id(1),
      agentId: 'agent',
      name: ' Fast review ',
      values: { model: 'small', reasoning_effort: 'low' },
    });
    const archived = presets.archive('agent', original.id, original.revision);
    storage.close();
    storage = openSqliteStorage({ filename });
    const reopened = new SqliteSessionPresetsRepository(storage.sqlite);
    expect(reopened.list('agent')).toEqual([]);
    expect(reopened.list('agent', { includeArchived: true })).toEqual([archived]);
    expect(reopened.get('agent', original.id)?.name).toBe('Fast review');
    for (const [table, rows] of Object.entries(before))
      expect(storage.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    expect(storage.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  } finally {
    if (storage?.sqlite.open) storage.close();
    removeFixture(root);
  }
});

it('uses CAS and agent isolation, keeps copied task settings stable and restores only conflict-free names', () => {
  const f = fixture(),
    second = openSqliteStorage({ filename: f.filename });
  try {
    const otherConnection = new SqliteSessionPresetsRepository(second.sqlite, () => at);
    const initial = f.presets.create({
      id: id(1),
      agentId: 'a',
      name: 'Focus',
      values: { model: 'small' },
    });
    const otherAgent = f.presets.create({
      id: id(1),
      agentId: 'b',
      name: 'Focus',
      values: { model: 'other' },
    });
    const settings = new SqliteSessionSettingsRepository(f.storage.sqlite);
    settings.putTask({
      taskId: 'task',
      agentId: 'a',
      requested: { ...initial.values },
      state: 'requested',
    });
    const renamed = f.presets.update('a', initial.id, 1, { name: ' Focus Fast ' });
    expect(renamed).toMatchObject({
      name: 'Focus Fast',
      revision: 2,
      values: initial.values,
      createdAt: initial.createdAt,
    });
    expectCode(
      () => otherConnection.update('a', initial.id, 1, { values: { model: 'stale' } }),
      'PRESET_REVISION_CONFLICT',
    );
    expectCode(
      () => f.presets.create({ id: id(2), agentId: 'a', name: 'focus fast', values: {} }),
      'PRESET_NAME_CONFLICT',
    );
    expectCode(
      () => f.presets.update('unrelated', initial.id, 2, { name: 'Wrong agent' }),
      'PRESET_NOT_FOUND',
    );
    const archived = f.presets.archive('a', initial.id, renamed.revision);
    expectCode(
      () => otherConnection.archive('a', initial.id, renamed.revision),
      'PRESET_REVISION_CONFLICT',
    );
    const replacement = f.presets.create({
      id: id(2),
      agentId: 'a',
      name: 'focus fast',
      values: { model: 'large' },
    });
    expectCode(() => f.presets.restore('a', initial.id, archived.revision), 'PRESET_NAME_CONFLICT');
    const safeName = f.presets.update('a', initial.id, archived.revision, {
      name: 'Kept old choice',
      values: { model: 'changed' },
    });
    const restored = f.presets.restore('a', initial.id, safeName.revision);
    expect(restored.archived).toBe(false);
    expect(f.presets.list('a').map((preset) => preset.id)).toEqual([initial.id, replacement.id]);
    expect(f.presets.get('b', initial.id)).toEqual(otherAgent);
    expect(settings.getTask('task')?.requested).toEqual({ model: 'small' });
    restored.values.model = 'local mutation';
    expect(f.presets.get('a', initial.id)?.values.model).toBe('changed');
  } finally {
    second.close();
    f.close();
  }
});

it('caps active and total presets while archiving releases active capacity', () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 32; n++)
      f.presets.create({ id: id(n), agentId: 'a', name: `Choice ${n}`, values: {} });
    expectCode(
      () => f.presets.create({ id: id(33), agentId: 'a', name: 'Choice 33', values: {} }),
      'PRESET_LIMIT_EXCEEDED',
    );
    const archived = f.presets.archive('a', id(1), 1);
    f.presets.create({ id: id(33), agentId: 'a', name: 'Choice 33', values: {} });
    expectCode(() => f.presets.restore('a', id(1), archived.revision), 'PRESET_LIMIT_EXCEEDED');
    f.presets.archive('a', id(2), 1);
    f.presets.restore('a', id(1), archived.revision);
    for (const preset of f.presets.list('a')) f.presets.archive('a', preset.id, preset.revision);
    for (let n = 34; n <= 128; n++) {
      const preset = f.presets.create({ id: id(n), agentId: 'a', name: `Choice ${n}`, values: {} });
      f.presets.archive('a', preset.id, preset.revision);
    }
    expect(f.presets.list('a', { includeArchived: true })).toHaveLength(128);
    expect(f.presets.list('a')).toEqual([]);
    expectCode(
      () => f.presets.create({ id: id(129), agentId: 'a', name: 'Choice 129', values: {} }),
      'PRESET_LIMIT_EXCEEDED',
    );
    expect(
      f.presets.create({ id: id(129), agentId: 'b', name: 'Independent agent', values: {} })
        .revision,
    ).toBe(1);
  } finally {
    f.close();
  }
});

it('validates strict input and rejects sensitive writes or unsafe persisted values', () => {
  const f = fixture();
  try {
    const input = { id: id(1), agentId: 'a', name: 'Review', values: { model: 'small' } };
    for (const changed of [
      { ...input, id: 'not-a-uuid' },
      { ...input, name: '   ' },
      { ...input, name: 'x'.repeat(81) },
      { ...input, extra: true },
      { ...input, values: { access_token: 'private-value' } },
    ])
      expect(() => f.presets.create(changed)).toThrow();
    expect(f.presets.list('a')).toEqual([]);
    const preset = f.presets.create(input);
    expect(() => f.presets.update('a', preset.id, 1, {})).toThrow();
    expect(() =>
      f.presets.update('a', preset.id, 1, {
        values: { model: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' },
      }),
    ).toThrow();
    expect(f.presets.get('a', preset.id)?.revision).toBe(1);
    f.storage.sqlite
      .prepare('UPDATE agent_session_presets SET payload = ? WHERE agent_id = ? AND id = ?')
      .run(JSON.stringify({ ...preset, values: { password: 'unsafe-old-value' } }), 'a', preset.id);
    expect(() => f.presets.get('a', preset.id)).toThrow();
  } finally {
    f.close();
  }
});
