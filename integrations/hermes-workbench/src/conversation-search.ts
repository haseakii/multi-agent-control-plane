export type ConversationFilter =
  | 'all'
  | 'active'
  | 'attention'
  | 'failed'
  | 'completed'
  | 'draft'
  | 'cancelled';
export interface SearchableConversation {
  id: string;
  title: string;
  state: string;
  searchText: string;
  pendingReview: boolean;
  pendingApproval: boolean;
  projectId?: string;
}

/** Project identity, not its display name, defines the history scope. */
export function scopeConversations<T extends SearchableConversation>(
  items: T[],
  projectId: string,
) {
  return projectId ? items.filter((item) => item.projectId === projectId) : items;
}

export function conversationProjects(
  items: SearchableConversation[],
  projects: { id: string; name: string }[],
) {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.projectId) counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => {
    const name = names.get(id) ?? `项目 ${id}`;
    const duplicate = [...counts.keys()].some((other) => other !== id && names.get(other) === name);
    return { id, name: duplicate ? `${name} · ${id}` : name, count };
  });
}
export function needsAttention(item: SearchableConversation) {
  return (
    item.pendingReview ||
    item.pendingApproval ||
    ['failed', 'blocked', 'waiting_approval'].includes(item.state)
  );
}
export function filterConversations<T extends SearchableConversation>(
  items: T[],
  query: string,
  filter: ConversationFilter,
): T[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const text = `${item.title}\n${item.searchText}`.toLocaleLowerCase();
    if (!words.every((word) => text.includes(word))) return false;
    switch (filter) {
      case 'all':
        return true;
      case 'attention':
        return needsAttention(item);
      case 'failed':
        return ['failed', 'blocked'].includes(item.state);
      case 'active':
        return [
          'planning',
          'ready',
          'running',
          'waiting',
          'waiting_approval',
          'queued',
          'assigned',
          'waiting_children',
        ].includes(item.state);
      case 'completed':
        return item.state === 'completed';
      case 'draft':
        return ['draft', 'created', 'pending'].includes(item.state);
      case 'cancelled':
        return item.state === 'cancelled';
    }
  });
}
