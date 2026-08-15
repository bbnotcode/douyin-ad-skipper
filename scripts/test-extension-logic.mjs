import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const options = await readFile(new URL('../options.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const worker = await readFile(new URL('../server/src/index.ts', import.meta.url), 'utf8');
const idempotencyMigration = await readFile(new URL('../server/migrations/0007_idempotent_submissions.sql', import.meta.url), 'utf8');

assert.doesNotMatch(content, /settings\.skipLabeledAds|const AD_LABELS|function checkCurrentVideo/, '不得恢复整条平台广告识别');
assert.doesNotMatch(options, /chrome\.permissions|state\.skipLabeledAds|skipLabeledAds:/, '选项页不得申请任意 API 域名或恢复旧广告开关');
assert.equal(manifest.optional_host_permissions, undefined, '公共版不得申请任意 HTTPS 域名权限');

assert.match(content, /communityConsentGranted:\s*false/, '社区同意默认必须关闭');
assert.match(content, /if \(!settings\.communityConsentGranted \|\| !settings\.communityEnabled\) return;/, '远程查询必须受同意状态保护');
assert.match(content, /actions\.length === 0/, '带操作按钮的必要提示不能被普通提示开关隐藏');

const delaysSource = content.match(/const COMMUNITY_RETRY_MS = (\[[^;]+\]);/)?.[1];
const retryFunction = content.match(/function communityRetryDelay\(failureCount\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(delaysSource && retryFunction, '缺少社区查询退避函数');
const retryContext = {};
vm.runInNewContext(`const COMMUNITY_RETRY_MS=${delaysSource};${retryFunction};globalThis.retry=communityRetryDelay;`, retryContext);
assert.deepEqual([1, 2, 3, 4, 99].map(retryContext.retry), [5000, 15000, 60000, 300000, 300000]);

assert.match(content, /cannot_vote_own_segment:\s*'这是你提交的片段/, '自己的投稿必须显示明确反馈');
assert.match(content, /ownedByMe:\s*item\.ownedByMe === true/, '社区查询必须保留投稿归属标识');
assert.match(content, /failureCount[\s\S]*retryAt/, '查询失败必须使用短期退避而不是成功缓存时长');
assert.match(worker, /ownedByMe/, '服务端查询必须返回当前匿名投稿归属');
assert.match(worker, /ON CONFLICT\(submitter_hash, client_request_id\)/, '投稿必须按请求 ID 幂等写入');
assert.match(idempotencyMigration, /CREATE UNIQUE INDEX[\s\S]*submitter_hash, client_request_id/, 'D1 必须有投稿幂等唯一索引');

console.log('扩展行为契约测试通过');
