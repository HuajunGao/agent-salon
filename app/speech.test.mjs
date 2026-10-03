import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable } from './speech.mjs';

test('speakable turns a chat message into what a listener should hear', () => {
  const names = { 58: 'Claude', 59: 'Codex', 8: '你' };
  const nameOf = id => names[id] || null;
  // references: a parenthesis of only refs is dropped, others become the author's name, unknown ones vanish
  assert.equal(speakable('结论（#209、#213）成立，但 #58 和 #59 都忽略了 #8 的约束', nameOf), '结论成立，但 Claude 和 Codex 都忽略了 你 的约束');
  assert.equal(speakable('同意 #999 的说法 (#58, #59)', nameOf), '同意 的说法');
  assert.equal(speakable('**结论**：@codex 说的 `Array.sort` 不对'), '结论：codex 说的 Array.sort 不对');
  assert.equal(speakable('看这段：\n```js\n[10,9,1].sort()\n```\n然后'), '看这段： （代码略） 然后');
  assert.equal(speakable('文档 [Node 发布表](https://nodejs.org/x) 和 https://a.b/c?d=1 都写了'), '文档 Node 发布表 和 （链接） 都写了');
  assert.equal(speakable('## 标题\n- 第一点\n1. 第二点'), '标题 第一点 第二点');
  assert.equal(speakable('a'.repeat(2000)).length, 1500);
});
