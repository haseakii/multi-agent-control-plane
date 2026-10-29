import { createHash } from 'node:crypto';
import {
  AcpPermissionReviewSchema,
  type AcpPermissionReview,
  type JsonValue,
  redactSensitiveText,
} from '@control-plane/core';

const fields = [
  'name',
  'title',
  'kind',
  'status',
  'rawInput',
  'content',
  'locations',
  '_meta',
] as const;
const sensitive =
  /token|secret|password|credential|authorization|cookie|grant|api.?key|^env(?:ironment)?$|headers|^_meta$|account|email|phone/i;
export const permissionIdentity = (value: string): string =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const type = (v: unknown): string =>
  v === undefined
    ? 'absent'
    : v === null
      ? 'null'
      : Array.isArray(v)
        ? 'array:' + v.length
        : typeof v;

/** One shared traversal budget, including JSON embedded in strings. No raw archive. */
export function redactPermissionValue(
  input: unknown,
  inspectMetadataPaths: readonly string[] = [],
): {
  value: JsonValue;
  truncated: boolean;
  redacted: boolean;
} {
  let nodes = 0,
    bytes = 0,
    truncated = false,
    redacted = false;
  const walk = (v: unknown, depth: number, key: string, path = ''): JsonValue => {
    if (++nodes > 256 || depth > 8 || bytes > 6000) {
      truncated = true;
      return '[truncated]';
    }
    if (
      (sensitive.test(key) && !(key === '_meta' && inspectMetadataPaths.includes(path))) ||
      key === 'rawOutput'
    ) {
      // An explicitly empty JSON field contains nothing to withhold. Do not
      // reject an otherwise reviewable call merely because the key is present.
      if (v === null) return null;
      if (Array.isArray(v) && v.length === 0) return [];
      if (
        v &&
        typeof v === 'object' &&
        (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) &&
        Object.keys(v).length === 0
      )
        return {};
      redacted = true;
      return '[withheld]';
    }
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      let text = v;
      if (text.length < 16384 && /^\s*[\[{]/.test(text)) {
        try {
          return JSON.stringify(walk(JSON.parse(text), depth + 1, ''));
        } catch {
          /* ordinary text */
        }
      }
      const shared = redactSensitiveText(text);
      redacted ||= shared.redacted;
      text = shared.text
        .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [withheld]')
        .replace(
          /(--?(?:api[-_]?key|token|password|secret|authorization|cookie)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
          '$1[withheld]',
        )
        .replace(
          /((?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
          '$1[withheld]',
        )
        .replace(/\bsk-[\w-]{12,}/g, '[withheld]')
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[withheld]');
      redacted ||= text !== shared.text;
      if (Buffer.byteLength(text) > 768) {
        text =
          Buffer.from(text)
            .subarray(0, 768)
            .toString('utf8')
            .replace(/\uFFFD$/, '') + '[truncated]';
        truncated = true;
      }
      bytes += Buffer.byteLength(text);
      return text;
    }
    if (Array.isArray(v)) {
      if (v.length > 16) truncated = true;
      return v.slice(0, 16).map((item, i) => {
        if (
          typeof v[i - 1] === 'string' &&
          /^--?(?:api[-_]?key|token|password|secret|authorization|cookie)$/i.test(v[i - 1])
        ) {
          redacted = true;
          return '[withheld]';
        }
        return walk(item, depth + 1, key, path + '.' + i);
      });
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.length > 24) truncated = true;
      const pair =
        (typeof object(v).name === 'string' && sensitive.test(object(v).name as string)) ||
        (typeof object(v).key === 'string' && sensitive.test(object(v).key as string));
      const result: Record<string, JsonValue> = {};
      for (const [i, [name, value]] of entries.slice(0, 24).entries()) {
        const safeKey = /^[\w$.-]{1,48}$/.test(name) ? name : 'key-' + i;
        if (pair && name === 'value') redacted = true;
        Object.defineProperty(result, safeKey, {
          enumerable: true,
          value:
            pair && name === 'value'
              ? '[withheld]'
              : walk(value, depth + 1, name, path ? path + '.' + name : name),
        });
      }
      return result;
    }
    return null;
  };
  return {
    value: walk(input, 0, ''),
    get truncated() {
      return truncated;
    },
    get redacted() {
      return redacted;
    },
  };
}

export type PermissionWireShape = {
  presence: Record<string, string>;
  structure: string;
  truncated: boolean;
  envelopeFiltered?: boolean;
};
/** Types/hashed key structure only, captured before SDK parsing; never values. */
export function permissionWireShape(call: unknown): PermissionWireShape {
  let count = 0,
    truncated = false;
  const shape = (v: unknown, depth: number): unknown => {
    if (++count > 128 || depth > 8) {
      truncated = true;
      return 'truncated';
    }
    if (Array.isArray(v)) {
      if (v.length > 16) truncated = true;
      return [type(v), ...v.slice(0, 16).map((x) => shape(x, depth + 1))];
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
      if (entries.length > 24) truncated = true;
      return entries
        .slice(0, 24)
        .map(([key, value]) => [permissionIdentity(key), shape(value, depth + 1)]);
    }
    return type(v);
  };
  const structure = JSON.stringify(shape(call, 0));
  return {
    presence: Object.fromEntries(fields.map((f) => [f, type(object(call)[f])])),
    structure,
    truncated,
  };
}

type Cached = {
  session: string;
  at: number;
  values: Record<string, unknown>;
  truncated: boolean;
  filtered: boolean;
  expired: boolean;
  redacted: boolean;
};
/** Optional adapter semantics. The collector still applies every wire/lifetime/redaction check. */
export type PermissionSemantics = {
  tool: string;
  action: string;
  target: string;
  parameters?: unknown;
};
export type PermissionSemanticResolver = (
  sessionId: string,
  toolCall: Readonly<Record<string, unknown>>,
) => PermissionSemantics | null;
export type PermissionMetadataValidator = (sessionId: string, metadata: unknown) => boolean;
export type PermissionContentMetadataValidator = (
  sessionId: string,
  call: Readonly<Record<string, unknown>>,
  metadata: unknown,
) => boolean;
export class PermissionReviewCollector {
  private readonly history = new Map<string, Cached>();
  constructor(
    private readonly clock: () => number = Date.now,
    readonly ttlMs = 300_000,
    private readonly resolver?: PermissionSemanticResolver,
    private readonly metadataValidator?: PermissionMetadataValidator,
    private readonly contentMetadataValidator?: PermissionContentMetadataValidator,
    private readonly contentSummarizer?: (
      session: string,
      call: Readonly<Record<string, unknown>>,
    ) => Record<string, unknown> | null,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300_000)
      throw new RangeError('ACP permission lifetime must be positive and at most five minutes.');
  }
  private key(session: string, id: string) {
    return permissionIdentity(JSON.stringify([session, id]));
  }
  private safeCall(session: string, call: Record<string, unknown>) {
    // Wire/SDK checks still compare the original, unmodified descriptor.
    try {
      call = this.contentSummarizer?.(session, call) ?? call;
    } catch {
      /* A failed adapter falls back to ordinary fail-closed redaction. */
    }
    let recognized = false;
    try {
      recognized = this.metadataValidator?.(session, call._meta) === true;
    } catch {
      /* Unknown metadata remains opaque. */
    }
    const metadataPaths = this.contentMetadataPaths(session, call);
    if (!recognized) return redactPermissionValue(call, metadataPaths);
    // Only an explicitly validated adapter descriptor can be inspected. Secret
    // scrubbing still applies to its values and all remaining call fields.
    const { _meta, ...remaining } = call;
    const safe = redactPermissionValue(remaining, metadataPaths);
    const metadata = redactPermissionValue(_meta);
    return {
      value: { ...object(safe.value), _meta: metadata.value },
      redacted: safe.redacted || metadata.redacted,
      truncated: safe.truncated || metadata.truncated,
    };
  }
  private contentMetadataPaths(session: string, call: Record<string, unknown>): string[] {
    if (!Array.isArray(call.content) || call.content.length > 16) return [];
    return call.content.flatMap((content, index) => {
      try {
        return this.contentMetadataValidator?.(session, call, object(content)._meta) === true
          ? [`content.${index}._meta`]
          : [];
      } catch {
        return [];
      }
    });
  }
  clear(session?: string): void {
    if (session === undefined) this.history.clear();
    else
      for (const [key, value] of this.history)
        if (value.session === permissionIdentity(session)) this.history.delete(key);
  }
  observe(session: string, update: unknown, wire?: PermissionWireShape): void {
    const call = object(update);
    if (typeof call.toolCallId !== 'string') return;
    const key = this.key(session, call.toolCallId),
      previous = this.history.get(key);
    const state: Cached =
      call.sessionUpdate === 'tool_call' || !previous || this.clock() - previous.at >= this.ttlMs
        ? {
            session: permissionIdentity(session),
            at: this.clock(),
            values: {},
            truncated: false,
            filtered: false,
            expired: call.sessionUpdate !== 'tool_call' && !!previous,
            redacted: false,
          }
        : previous;
    const safe = this.safeCall(session, call),
      sdk = permissionWireShape(call);
    // sessionUpdate is part of both wire and SDK update shapes.
    state.filtered ||= !wire || !!wire.envelopeFiltered || wire.structure !== sdk.structure;
    state.truncated ||= safe.truncated || sdk.truncated || !!wire?.truncated;
    state.redacted ||= safe.redacted;
    for (const field of fields)
      if (call[field] !== undefined && (call[field] !== null || field === 'name'))
        state.values[field] = object(safe.value)[field];
    // Null/no-op patches do not extend the lifetime of old actionable fields.
    this.history.delete(key);
    this.history.set(key, state);
    while (this.history.size > 32) this.history.delete(this.history.keys().next().value!);
  }
  review(session: string, call: unknown, wire?: PermissionWireShape): AcpPermissionReview {
    const now = this.clock(),
      value = object(call),
      sdk = permissionWireShape(call);
    const entry =
      typeof value.toolCallId === 'string'
        ? this.history.get(this.key(session, value.toolCallId))
        : undefined;
    const stale = !!entry && now - entry.at >= this.ttlMs;
    const previous = entry && !stale ? entry : undefined;
    const safe = this.safeCall(session, value),
      values = { ...previous?.values };
    const provenance: AcpPermissionReview['provenance'] = {},
      presence: AcpPermissionReview['presence'] = {};
    for (const field of fields) {
      // Describe presence without reusing the sensitive wire key as a public value field.
      const publicField = field === '_meta' ? 'adapterMetadata' : field;
      presence[publicField] = {
        wire: wire?.presence[field] ?? 'unavailable',
        sdk: sdk.presence[field]!,
      };
      if (value[field] !== undefined && (value[field] !== null || field === 'name')) {
        values[field] = object(safe.value)[field];
        provenance[publicField] = 'request';
      } else provenance[publicField] = Object.hasOwn(values, field) ? 'history' : 'unknown';
    }
    const input = object(values.rawInput),
      args = object(input.arguments);
    const text = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() && !/\[withheld\]|\[truncated\]|\?withheld/.test(v)
        ? v
        : null;
    let tool = text(input.tool),
      action = text(input.action) ?? text(args.action);
    let target: string | null = null;
    for (const source of [input, args])
      for (const key of [
        'target',
        'path',
        'filePath',
        'url',
        'taskId',
        'agentId',
        'artifactId',
        'Cwd',
        'cwd',
        'workingDirectory',
        'TargetFile',
        'targetFile',
        'Path',
        'CommandLine',
        'commandLine',
        'command',
      ])
        target ??= text(source[key]);
    if (!target && Array.isArray(values.locations) && values.locations.length === 1)
      target = text(object(values.locations[0]).path);
    // Resolver receives only bounded, sanitized fields correlated to this exact call.
    // A failed adapter cannot make incomplete generic details actionable.
    let semantics: PermissionSemantics | null = null;
    try {
      semantics = this.resolver?.(session, values) ?? null;
    } catch {
      /* Unrecognized adapter details remain subject to the generic review. */
    }
    if (semantics) {
      tool = text(semantics.tool);
      action = text(semantics.action);
      target = text(semantics.target);
    }
    tool ??= text(values.name) ?? text(input.name);
    if (!tool) {
      if (
        values.kind === 'execute' ||
        text(input.CommandLine) ||
        text(input.commandLine) ||
        text(input.command)
      ) {
        tool = 'run_command';
      } else if (
        values.kind === 'edit' ||
        (text(input.TargetFile) && (text(input.ReplacementContent) || text(input.TargetContent)))
      ) {
        tool = 'edit_file';
      } else if (text(input.TargetFile) && text(input.CodeContent)) {
        tool = 'create_file';
      } else if (values.kind === 'read') {
        tool = 'read_file';
      }
    }
    if (!action) {
      if (
        values.kind === 'execute' ||
        tool === 'run_command' ||
        text(input.CommandLine) ||
        text(input.commandLine) ||
        text(input.command)
      ) {
        action = 'process.execute';
      } else if (
        values.kind === 'edit' ||
        tool === 'edit_file' ||
        tool === 'create_file' ||
        text(input.TargetFile) ||
        text(input.targetFile)
      ) {
        action = 'file.write';
      } else if (values.kind === 'read' || tool === 'read_file') {
        action = 'file.read';
      } else if (values.kind && typeof values.kind === 'string') {
        action = `acp.${values.kind}`;
      }
    }
    if (!target) {
      if (tool === 'run_command' || action === 'process.execute') {
        target =
          text(input.Cwd) ??
          text(input.cwd) ??
          text(input.workingDirectory) ??
          text(input.CommandLine) ??
          text(input.commandLine) ??
          text(input.command);
      } else if (tool === 'edit_file' || tool === 'create_file' || action === 'file.write') {
        target =
          text(input.TargetFile) ??
          text(input.targetFile) ??
          text(input.path) ??
          text(input.filePath);
      }
    }
    const resolvedParams =
      semantics?.parameters !== undefined
        ? semantics.parameters
        : (tool === 'run_command' || action === 'process.execute') &&
            (input.CommandLine ||
              input.commandLine ||
              input.command ||
              input.Cwd ||
              input.cwd ||
              input.workingDirectory)
          ? {
              command:
                text(input.CommandLine) ??
                text(input.commandLine) ??
                text(input.command) ??
                undefined,
              workingDirectory:
                text(input.Cwd) ??
                text(input.cwd) ??
                text(input.workingDirectory) ??
                undefined,
            }
          : undefined;
    const parameters = redactPermissionValue(
      {
        rawInput: values.rawInput ?? null,
        locations: values.locations ?? [],
        content: values.content ?? [],
        ...(resolvedParams ? { resolved: resolvedParams } : {}),
      },
      this.contentMetadataPaths(session, values),
    );
    const reasons: AcpPermissionReview['reasons'] = [];
    if (!tool) reasons.push('missing_tool');
    if (!action) reasons.push('missing_action');
    if (!target) reasons.push('missing_target');
    if (!wire) reasons.push('wire_unavailable');
    if ((wire && (wire.envelopeFiltered || wire.structure !== sdk.structure)) || previous?.filtered)
      reasons.push('sdk_filtered');
    if (
      safe.truncated ||
      sdk.truncated ||
      wire?.truncated ||
      previous?.truncated ||
      parameters.truncated
    )
      reasons.push('truncated');
    if (safe.redacted || previous?.redacted || parameters.redacted)
      reasons.push('sensitive_redacted');
    const historyUsed = Object.values(provenance).includes('history');
    if ((stale || previous?.expired) && reasons.some((r) => r.startsWith('missing_')))
      reasons.push('history_expired');
    let review: AcpPermissionReview = {
      version: 1,
      status: reasons.includes('truncated')
        ? 'truncated'
        : reasons.includes('sdk_filtered') ||
            reasons.includes('wire_unavailable') ||
            reasons.includes('sensitive_redacted')
          ? 'invalid'
          : reasons.includes('history_expired')
            ? 'expired'
            : reasons.length
              ? 'missing'
              : 'complete',
      tool,
      action,
      target,
      parameters: parameters.value,
      provenance,
      presence,
      reasons,
      historyUsed,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(
        historyUsed ? Math.min(now + this.ttlMs, previous!.at + this.ttlMs) : now + this.ttlMs,
      ).toISOString(),
    };
    if (Buffer.byteLength(JSON.stringify(review)) > 16384)
      review = {
        ...review,
        status: 'truncated',
        parameters: '[truncated]',
        reasons: [...new Set([...reasons, 'truncated' as const])],
      };
    return AcpPermissionReviewSchema.parse(review);
  }
}
