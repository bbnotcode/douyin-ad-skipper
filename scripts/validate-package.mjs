import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || '');
assert.ok(process.argv[2], '请提供解压后的扩展目录');
const rootUrl = pathToFileURL(`${root}/`);
const manifest = JSON.parse(await readFile(new URL('manifest.json', rootUrl), 'utf8'));
const required = new Set([
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
]);
for (const entry of manifest.content_scripts || []) {
  for (const file of [...(entry.js || []), ...(entry.css || [])]) required.add(file);
}
for (const file of required) {
  assert.equal(typeof file, 'string');
  await access(new URL(file, rootUrl));
}
const topLevel = await readdir(root);
for (const forbidden of ['server', '.git', '.github', 'wrangler.jsonc', '.dev.vars']) {
  assert.ok(!topLevel.includes(forbidden), `发布包不应包含 ${forbidden}`);
}
console.log(`发布包校验通过 v${manifest.version}`);
