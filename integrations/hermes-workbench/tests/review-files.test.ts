import { expect, it } from 'vitest';
import { filterReviewFiles, reviewFileNavigation, type ReviewFile } from '../src/review-files';
const files: ReviewFile[] = [
  { path: 'src/main.ts', status: 'M', additions: 8, deletions: 2 },
  { path: 'src/theme.css', status: 'A', additions: 12, deletions: 0 },
  { path: 'assets/icon.png', status: 'D', additions: null, deletions: null },
  { path: '中文目录/说明.md', status: 'T', additions: 1, deletions: 1 },
];
it('combines path terms and change type without changing the reviewed manifest', () => {
  const before = JSON.stringify(files);
  expect(filterReviewFiles(files, ' SRC\\ .CSS ', 'A')).toEqual([files[1]]);
  expect(filterReviewFiles(files, '中文 说明', 'T')).toEqual([files[3]]);
  expect(filterReviewFiles(files, '.css', 'D')).toEqual([]);
  expect(filterReviewFiles(files, '', 'D')).toEqual([files[2]]);
  expect(JSON.stringify(files)).toBe(before);
});
it('navigates only visible results and never silently substitutes an unrelated selected file', () => {
  const visible = filterReviewFiles(files, 'src', 'all');
  expect(reviewFileNavigation(visible, 'src/main.ts')).toEqual({
    index: 0,
    previous: undefined,
    next: 'src/theme.css',
    first: 'src/main.ts',
  });
  expect(reviewFileNavigation(visible, 'src/theme.css')).toEqual({
    index: 1,
    previous: 'src/main.ts',
    next: undefined,
    first: 'src/main.ts',
  });
  expect(reviewFileNavigation(visible, 'assets/icon.png')).toEqual({
    index: -1,
    previous: undefined,
    next: undefined,
    first: 'src/main.ts',
  });
  expect(reviewFileNavigation([], 'src/main.ts')).toEqual({
    index: -1,
    previous: undefined,
    next: undefined,
    first: undefined,
  });
});
