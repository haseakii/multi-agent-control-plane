import { selectableAgents } from './agent-selection';

export type MemberFilter = 'all' | 'ready' | 'busy' | 'attention' | 'disabled';
interface Member {
  definition: {
    id: string;
    name: string;
    description?: string;
    capabilities: { name: string }[];
    enabled: boolean;
    orchestration: { canBeBoss: boolean };
    controlBridge: { transport: string; scopes: string[] };
  };
  readiness: { runtime: string; auth: string };
}

export function memberStatus(
  member: Member,
  active: ReadonlySet<string> = new Set(),
): Exclude<MemberFilter, 'all'> {
  if (active.has(member.definition.id)) return 'busy';
  if (!member.definition.enabled) return 'disabled';
  return selectableAgents([member], 'direct').length ? 'ready' : 'attention';
}

export function filterMembers<T extends Member>(
  members: T[],
  query: string,
  filter: MemberFilter,
  active: ReadonlySet<string> = new Set(),
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return members.filter((member) => {
    const { definition } = member;
    const text = [
      definition.name,
      definition.id,
      definition.description ?? '',
      ...definition.capabilities.map((capability) => capability.name),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return (
      (filter === 'all' || memberStatus(member, active) === filter) &&
      terms.every((term) => text.includes(term))
    );
  });
}
