import { describe, it, expect, vi } from 'vitest';
import {
  detectInstalledAgentCLIs,
  findExecutableInPath,
  KNOWN_CLIS,
  detectLocalProxy,
} from './agent-auto-discovery.js';

describe('agent-auto-discovery', () => {
  it('defines known agent CLIs', () => {
    expect(KNOWN_CLIS.length).toBeGreaterThanOrEqual(4);
    const agy = KNOWN_CLIS.find((c) => c.id === 'antigravity');
    expect(agy).toBeDefined();
    expect(agy?.name).toBe('Google Antigravity');
    expect(agy?.binaryNames).toContain('agy');
  });

  it('detects CLI installed in custom test path', () => {
    // When searching an empty path, installed is false
    const results = detectInstalledAgentCLIs([], 'C:\\non-existent-empty-dir-xyz');
    expect(results).toHaveLength(KNOWN_CLIS.length);
    for (const r of results) {
      expect(r.registered).toBe(false);
    }
  });

  it('marks CLI as registered when matching command exists', () => {
    const results = detectInstalledAgentCLIs(['agy', 'codebuddy'], 'C:\\non-existent');
    const agy = results.find((r) => r.id === 'antigravity');
    const codebuddy = results.find((r) => r.id === 'codebuddy');
    const ollama = results.find((r) => r.id === 'ollama');

    expect(agy?.registered).toBe(true);
    expect(codebuddy?.registered).toBe(true);
    expect(ollama?.registered).toBe(false);
  });

  it('returns clean proxy detection result when ports are unreachable', async () => {
    const result = await detectLocalProxy();
    // In test environment, returns structured object
    expect(result).toHaveProperty('detected');
    if (result.detected) {
      expect(result.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }
  });
});
