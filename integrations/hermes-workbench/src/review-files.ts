export type ReviewFileStatus = 'A' | 'M' | 'D' | 'T';
export type ReviewFileFilter = 'all' | ReviewFileStatus;
export const reviewFileLabels: Record<ReviewFileStatus, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  T: '类型变更',
};
export type ReviewFile = {
  path: string;
  status: ReviewFileStatus;
  additions: number | null;
  deletions: number | null;
};

export function filterReviewFiles<T extends ReviewFile>(
  files: readonly T[],
  query: string,
  status: ReviewFileFilter,
) {
  const terms = query.trim().replaceAll('\\', '/').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return files.filter(
    (file) =>
      (status === 'all' || file.status === status) &&
      terms.every((term) => file.path.toLocaleLowerCase().includes(term)),
  );
}

export function reviewFileNavigation(files: readonly ReviewFile[], selectedPath?: string) {
  const index = files.findIndex((file) => file.path === selectedPath);
  return {
    index,
    previous: index > 0 ? files[index - 1]?.path : undefined,
    next: index >= 0 ? files[index + 1]?.path : undefined,
    first: files[0]?.path,
  };
}
