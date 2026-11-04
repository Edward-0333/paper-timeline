import test from 'node:test';
import assert from 'node:assert/strict';
import { dateFromParts, formatPublicationDate, groupPapersByPublication, parsePublicationDate, publicationDateOf } from '../shared/publication-date';
import type { Paper } from '../shared/types';

test('publication dates preserve precision and reject impossible calendar dates', () => {
  for (const date of ['2025', '2025-04', '2025-04-02', '2024-02-29']) assert.equal(parsePublicationDate(date), date);
  for (const date of ['', '2025-2-3', '2025-02-29', '2025-04-31', '2025-00', '2025-13', '2025-01-00', '2025-01-01T00:00:00Z', '0999', null, 2025]) assert.equal(parsePublicationDate(date), null);
  assert.equal(dateFromParts([2025]), '2025');
  assert.equal(dateFromParts([2025, 4]), '2025-04');
  assert.equal(dateFromParts([2025, 4, 2]), '2025-04-02');
  assert.equal(dateFromParts([null]), '');
  assert.equal(dateFromParts([2025, 0]), '');
  assert.equal(dateFromParts([2025, 4, 2, 4]), '');
  assert.equal(formatPublicationDate('2025-04-02'), '2025 年 4 月 2 日');
  assert.equal(formatPublicationDate('2025-04', true), '4 月');
  assert.equal(formatPublicationDate('2025', true), '仅年份');
  assert.equal(formatPublicationDate(''), '日期待补充');
});

test('timeline uses publication date with legacy years and stable ties, never import time', () => {
  const make = (id: string, date: string | undefined, year: number | null, importedAt: string): Paper => ({
    id, title: id, publicationDate: date, year, importedAt, authors: [], venue: '', doi: '', arxivId: '', abstract: '', url: '', source: 'PDF', matchMethod: '', fileName: `${id}.pdf`, fileSize: 20, pageCount: 1, status: 'matched', message: '',
  });
  const input = [make('unknown', '', null, '2099-01-01'), make('old', undefined, 2024, '2098-01-01'),
    make('year-only', undefined, 2025, '2097-01-01'), make('month-only', '2025-04', 2025, '2096-01-01'),
    make('tie-b', '2025-04-02', 2025, '2095-01-01'), make('tie-a', '2025-04-02', 2025, '1995-01-01'),
    make('newest', '2026-01-08', 2026, '1990-01-01')];
  const original = [...input];
  const groups = groupPapersByPublication(input);
  assert.deepEqual(groups.map(g => g.year), ['2026', '2025', '2024', '']);
  assert.deepEqual(groups.flatMap(g => g.papers.map(p => p.id)), ['newest', 'tie-a', 'tie-b', 'month-only', 'year-only', 'old', 'unknown']);
  assert.deepEqual(input, original);
  assert.equal(publicationDateOf({ publicationDate: 'bad', year: 2025 }), '2025');
  assert.equal(publicationDateOf({ year: null }), '');
});
