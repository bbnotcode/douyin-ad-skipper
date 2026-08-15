import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const tag = process.argv[2] || '';
const output = process.argv[3] || '';
assert.match(tag, /^v\d+\.\d+\.\d+$/, '标签必须为 vX.Y.Z');
assert.ok(output, '缺少发布说明输出路径');
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const version = tag.slice(1);
const heading = `## ${version}`;
const start = changelog.split('\n').findIndex((line) => line.startsWith(heading));
assert.notEqual(start, -1, `CHANGELOG 缺少 ${tag} 的发布内容`);
const lines = changelog.split('\n').slice(start + 1);
const end = lines.findIndex((line) => line.startsWith('## '));
const section = lines.slice(0, end === -1 ? undefined : end).join('\n').trim();
assert.ok(section, `CHANGELOG 缺少 ${tag} 的发布内容`);
await writeFile(output, section + '\n');
console.log(`已生成 ${tag} 发布说明`);
