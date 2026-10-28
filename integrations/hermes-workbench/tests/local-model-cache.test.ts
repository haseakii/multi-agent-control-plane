import { describe, it, expect, beforeEach } from 'vitest';
import {
  readLocalModelCache,
  writeLocalModelCache,
  formatModelLabel,
} from '../src/local-model-cache';

// Mock localStorage for node environment
const store: Record<string, string> = {};
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};

describe('local-model-cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns well-known models for antigravity agent when cache is empty', () => {
    const models = readLocalModelCache('agy-agent', 'Google Antigravity');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.name.includes('Gemini 3.8 Flash'))).toBe(true);
    expect(models.some((m) => m.name.includes('Claude Sonnet 4.6'))).toBe(true);
  });

  it('persists and retrieves cached models in localStorage', () => {
    writeLocalModelCache('custom-agent-1', [
      { value: 'gpt-4o', name: 'GPT-4o' },
      { value: 'claude-3-opus', name: 'Claude 3 Opus' },
    ]);

    const cached = readLocalModelCache('custom-agent-1');
    expect(cached).toHaveLength(2);
    expect(cached[0]).toEqual({ value: 'gpt-4o', name: 'GPT-4o' });
  });

  it('merges new models into existing cache without duplicates', () => {
    writeLocalModelCache('custom-agent-2', [{ value: 'model-a', name: 'Model A' }]);
    writeLocalModelCache('custom-agent-2', [
      { value: 'model-a', name: 'Model A Updated' },
      { value: 'model-b', name: 'Model B' },
    ]);

    const cached = readLocalModelCache('custom-agent-2');
    expect(cached).toHaveLength(2);
    expect(cached.find((m) => m.value === 'model-a')?.name).toBe('Model A Updated');
    expect(cached.find((m) => m.value === 'model-b')?.name).toBe('Model B');
  });

  it('formats model labels cleanly', () => {
    expect(formatModelLabel('gemini-3.8-flash')).toBe('Gemini 3.8 Flash');
    expect(formatModelLabel('claude-sonnet-4.6')).toBe('Claude Sonnet 4.6');
    expect(formatModelLabel('unknown-custom-model')).toBe('unknown-custom-model');
  });
});
