import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTagColors, collectTagOptions, paperHasTag, paperMatchesTags, tagKey } from '../shared/paper-tags';
import type { Paper, PaperTag } from '../shared/types';

const paper = (id: string, tags?: PaperTag[]): Paper => ({
  id, tags, title: id, authors: [], year: null, venue: '', doi: '', arxivId: '',
  abstract: '', url: '', source: 'PDF', matchMethod: '', fileName: `${id}.pdf`,
  fileSize: 0, pageCount: 1, importedAt: '', status: 'matched', message: '',
});
const tag = (text: string, id = text, color = '#AABBCC'): PaperTag => ({ id, text, color });

test('intersection requires every selected tag while union accepts either, and no selection shows all papers', () => {
  const papers = [paper('both', [tag('视觉'), tag('网络')]), paper('vision', [tag('视觉')]),
    paper('network', [tag('网络')]), paper('other', [tag('BEV')]), paper('untagged')];
  const ids = (selected: string[], mode: 'all' | 'any') => papers.filter(item => paperMatchesTags(item, selected, mode)).map(item => item.id);
  assert.deepEqual(ids(['视觉', '网络'], 'all'), ['both']);
  assert.deepEqual(ids(['视觉', '网络'], 'any'), ['both', 'vision', 'network']);
  for (const mode of ['all', 'any'] as const) {
    assert.deepEqual(ids([], mode), papers.map(item => item.id));
    assert.deepEqual(ids(['视觉'], mode), ['both', 'vision']);
    assert.deepEqual(ids(['missing'], mode), []);
  }
  assert.deepEqual(ids(['视觉', 'missing'], 'all'), []);
  assert.deepEqual(ids(['视觉', 'missing'], 'any'), ['both', 'vision']);
});

test('multi-tag matching normalizes duplicate names without depending on color, order or mutating inputs', () => {
  const item = paper('one', [tag(' Research ', 'first', '#112233'), tag('网络', 'second', '#445566')]);
  const names = Object.freeze([' RESEARCH ', 'research', '网络']);
  const before = structuredClone(item);
  assert.equal(paperMatchesTags(item, names), true);
  assert.equal(paperMatchesTags(item, [...names].reverse(), 'all'), true);
  assert.equal(paperMatchesTags(item, ['search', 'first', '#112233'], 'any'), false);
  assert.deepEqual(item, before);
});

test('tag filters use exact trimmed case-insensitive names, independent of IDs and colors', () => {
  const item = paper('one', [tag('  Research  ', 'unique-id'), tag('视觉-动作')]);
  assert.equal(tagKey('  ReSeArCh  '), 'research');
  for (const text of ['research', ' RESEARCH ', '视觉-动作']) assert.equal(paperHasTag(item, text), true);
  for (const text of ['search', 'unique-id', '#AABBCC', '视觉', '', '   ']) assert.equal(paperHasTag(item, text), false);
  assert.equal(paperHasTag(paper('legacy'), 'Research'), false);
  assert.equal(paperHasTag(paper('empty', []), 'Research'), false);
});

test('tag choices merge names across papers and count each paper once without mutating its tags', () => {
  const papers = [
    paper('first', [tag(' Research ', 'a', '#112233'), tag('RESEARCH', 'b'), tag('视觉-动作', 'c')]),
    paper('second', [tag('research', 'd', '#445566'), tag('视觉-动作', 'e')]),
    paper('legacy'), paper('empty', []), paper('third', [tag('单一网络', 'f')]),
  ];
  const before = structuredClone(papers);
  for (const item of papers) {
    item.tags?.forEach(Object.freeze);
    if (item.tags) Object.freeze(item.tags);
    Object.freeze(item);
  }
  Object.freeze(papers);
  const options = collectTagOptions(papers);
  assert.equal(options.length, 3);
  assert.deepEqual(options.find(option => option.key === 'research'), { key: 'research', text: 'Research', color: '#112233', count: 2 });
  assert.equal(options.find(option => option.key === '视觉-动作')?.count, 2);
  assert.equal(options.find(option => option.key === '单一网络')?.count, 1);
  assert.deepEqual(papers, before);
  options[0].text = 'Changed only in result';
  assert.deepEqual(papers, before);
});

test('tag choices have stable Chinese and natural numeric ordering with empty-library compatibility', () => {
  const papers = [paper('all', ['视觉', '标签10', '网络', '标签2', '动作'].map(text => tag(text)))];
  assert.deepEqual(collectTagOptions(papers).map(option => option.text), ['标签2', '标签10', '动作', '视觉', '网络']);
  assert.deepEqual(collectTagOptions([paper('reversed', [...papers[0].tags!].reverse())]), collectTagOptions(papers));
  assert.deepEqual(collectTagOptions([]), []);
  assert.deepEqual(collectTagOptions([paper('legacy'), paper('empty', [])]), []);
});

test('same-name tag colors use the most frequent normalized HEX value with deterministic ties', () => {
  const papers = [
    paper('first', [tag(' Research ', 'a', '#aabbcc'), tag('Tie', 't1', '#998877')]),
    paper('second', [tag('RESEARCH', 'b', '#AABBCC'), tag(' TIE ', 't2', '#112233')]),
    paper('third', [tag('research', 'c', '#112233')]),
    paper('legacy'), paper('empty', []),
  ];
  const before = structuredClone(papers);
  const colors = collectTagColors(papers);
  assert.equal(colors.get('research'), '#AABBCC');
  assert.equal(colors.get('tie'), '#112233');
  assert.deepEqual([...collectTagColors([...papers].reverse())].sort(), [...colors].sort());
  assert.equal(collectTagOptions(papers).find(option => option.key === 'research')?.color, '#AABBCC');
  assert.equal(collectTagOptions(papers).find(option => option.key === 'tie')?.color, '#112233');
  assert.deepEqual(papers, before);
  assert.deepEqual([...collectTagColors([])], []);
});
