import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChatMath } from '../src/chat-math';

test('model LaTeX delimiters render alongside existing dollar math without changing the stored source', () => {
  const original = String.raw`行内 \(x_i^2\) 与 $E=mc^2$。
\[
\frac{1}{n}\sum_i x_i
\]`;
  const normalized = normalizeChatMath(original);
  assert.ok(normalized.includes('$$x_i^2$$'));
  assert.ok(normalized.includes('$E=mc^2$'));
  assert.ok(normalized.includes('\n$$\n\n\\frac{1}{n}\\sum_i x_i\n\n$$\n'));
  assert.ok(original.includes('\\(x_i^2\\)'));
});

test('inline, fenced, indented and unfinished code keeps literal math delimiters', () => {
  for (const source of ['代码 `\\(literal\\)`', '```python\nprint("\\(x\\)")\n```',
    '~~~text\n\\[example\\]\n~~~~\n', '    \\(literal\\)\n', '\t\\[example\\]\n', '```text\n\\(unfinished code\\)']) {
    assert.equal(normalizeChatMath(source), source);
  }
});

test('escaped delimiters, literal escaped backticks and unmatched math keep their intended meaning', () => {
  assert.equal(normalizeChatMath(String.raw`\\(literal\\) 与 \(y\)`), String.raw`\\(literal\\) 与 $$y$$`);
  assert.equal(normalizeChatMath('\\`literal\\` 与 \\(y\\)'), '\\`literal\\` 与 $$y$$');
  assert.equal(normalizeChatMath(String.raw`保留 \(unfinished`), String.raw`保留 \(unfinished`);
});
