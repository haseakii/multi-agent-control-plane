export const LOCAL_MODEL_CACHE_PREFIX = 'hermes:model-cache:';

export interface CachedModelOption {
  value: string;
  name: string;
  description?: string;
}

// Built-in known models as zero-wait fallback for standard CLI tools
export const WELL_KNOWN_MODELS: Record<string, CachedModelOption[]> = {
  antigravity: [
    { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'claude-opus-4.6', name: 'Claude Opus 4.6 (Thinking)' },
    { value: 'gpt-oss-120b', name: 'GPT-OSS 120B (Medium)' },
    { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  ],
};

export function readLocalModelCache(agentId: string, agentName?: string): CachedModelOption[] {
  try {
    const raw =
      typeof window !== 'undefined'
        ? localStorage.getItem(`${LOCAL_MODEL_CACHE_PREFIX}${agentId}`)
        : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // ignore
  }
  const key = (agentName || agentId).toLowerCase();
  if (key.includes('antigravity') || key.includes('agy')) {
    return WELL_KNOWN_MODELS.antigravity;
  }
  return [];
}

export function writeLocalModelCache(agentId: string, models: CachedModelOption[]) {
  try {
    if (!models || models.length === 0 || typeof window === 'undefined') return;
    const existing = readLocalModelCache(agentId);
    const map = new Map<string, CachedModelOption>();
    for (const m of existing) map.set(m.value, m);
    for (const m of models) map.set(m.value, m);
    localStorage.setItem(
      `${LOCAL_MODEL_CACHE_PREFIX}${agentId}`,
      JSON.stringify(Array.from(map.values())),
    );
  } catch {
    // ignore
  }
}

export function formatModelLabel(value: string): string {
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower.includes('gemini-3.8-flash') || lower === 'gemini 3.8 flash') return 'Gemini 3.8 Flash';
  if (lower.includes('claude-sonnet-4.6') || lower.includes('sonnet 4.6'))
    return 'Claude Sonnet 4.6';
  if (lower.includes('claude-opus-4.6') || lower.includes('opus 4.6')) return 'Claude Opus 4.6';
  if (lower.includes('gpt-oss-120b') || lower.includes('gpt-oss')) return 'GPT-OSS 120B';
  if (lower.includes('gemini-4-argon') || lower.includes('gemini 4')) return 'Gemini 4 Argon';
  return value;
}
