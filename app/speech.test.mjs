import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable } from './speech.mjs';

test('speakable turns a chat message into what a listener should hear', () => {
  assert.equal(speakable('**结论**：见 #58，@codex 说的 `Array.sort` 不对'), '结论：见 58号，codex 说的 Array.sort 不对');
  assert.equal(speakable('看这段：\n```js\n[10,9,1].sort()\n```\n然后'), '看这段： （代码略） 然后');
  assert.equal(speakable('文档 [Node 发布表](https://nodejs.org/x) 和 https://a.b/c?d=1 都写了'), '文档 Node 发布表 和 （链接） 都写了');
  assert.equal(speakable('## 标题\n- 第一点\n1. 第二点'), '标题 第一点 第二点');
  assert.equal(speakable('a'.repeat(2000)).length, 1500);
});
