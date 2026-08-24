import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.manifest_version, 3, '必须使用 Manifest V3');
assert.equal(manifest.name, '抖音网页版社区片段助手');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, '扩展版本必须使用 x.y.z');
assert.deepEqual(manifest.permissions, ['storage'], '新增 Chrome 权限前必须经过安全审查');
assert.deepEqual(manifest.host_permissions, [
  'https://www.douyin.com/*',
  'https://douyin-ad-skipper-api.douyin-skip-community.workers.dev/*',
]);
assert.equal(manifest.optional_host_permissions, undefined, '公共版不得申请任意 HTTPS 域名权限');

const requiredFiles = new Set([
  'player-adapter.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css',
  'options.html', 'options.js', 'options.css', 'PRIVACY.md', 'SECURITY.md',
]);
for (const file of requiredFiles) await access(new URL(`../${file}`, import.meta.url));
for (const script of manifest.content_scripts || []) {
  for (const file of [...(script.js || []), ...(script.css || [])]) await access(new URL(`../${file}`, import.meta.url));
}
for (const file of Object.values(manifest.icons || {})) await access(new URL(`../${file}`, import.meta.url));

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
assert.match(changelog, new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}(?: |$)`, 'm'), 'CHANGELOG 缺少当前版本');

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const adapterSource = await readFile(new URL('../player-adapter.js', import.meta.url), 'utf8');
assert(!/\beval\s*\(|new\s+Function\s*\(/.test(source), '内容脚本禁止动态执行代码');
assert(!/\beval\s*\(|new\s+Function\s*\(/.test(adapterSource), '播放器适配脚本禁止动态执行代码');
assert(!/settings\.skipLabeledAds|const AD_LABELS|function checkCurrentVideo/.test(source), '不得恢复整条平台广告识别');
console.log(`扩展校验通过 v${manifest.version}`);
