# 社区共享服务端

Cloudflare Workers + D1 的社区片段 API。新片段提交成功后立即成为 `trusted` 并供其他用户使用；投票与举报用于事后纠错。

## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

另一个终端测试：

```bash
curl http://localhost:8787/health
curl http://localhost:8787/v1/videos/7669344658548047311/segments
```

## 部署

1. 登录 Cloudflare：`npx wrangler login`。
2. 设置匿名身份哈希盐：`npx wrangler secret put CLIENT_HASH_SALT`。
3. 首次使用先运行 `npx wrangler d1 create douyin_ad_skipper`，把返回的数据库 ID 填入本地 `wrangler.jsonc` 的 `d1_databases[0].database_id`。
4. 应用远程迁移：`npm run db:migrate:remote`。
5. 部署 Worker：`npm run deploy`。
6. 自建分支需要同时替换扩展中的 API 常量和 `manifest.json` 精确域名权限；公共发布版不提供任意服务器地址输入框。

生产环境必须设置 `CLIENT_HASH_SALT`，否则所有写接口返回 `503`。不要提交 `.dev.vars`。

## 接口

- `GET /health`
- `GET /v1/videos/:videoId/segments`
- `GET /v1/videos/by-hash/:sha256/segments`
- `GET /v1/me/segments`
- `POST /v1/segments`
- `PATCH /v1/me/segments/:segmentId`
- `DELETE /v1/me/segments/:segmentId`
- `POST /v1/segments/:segmentId/votes`
- `POST /v1/segments/:segmentId/reports`
- `POST /v1/segments/:segmentId/skips`

写请求和需要识别“自己的投稿”的查询必须携带随机生成的 `X-Client-ID`。服务端使用加盐哈希保存稳定的匿名贡献身份，不保存客户端 ID 原值；来源 IP 会单独加盐哈希，仅用于第二层限流和基础设施安全，不参与贡献身份。`X-Client-ID` 不是登录凭证。

写接口的 JSON 请求体最大为 8 KiB，并同时按匿名身份和来源 IP 限流。提交使用 `(submitter_hash, client_request_id)` 唯一约束保证网络重试幂等。相似投稿在查询阶段聚合；投稿者修改或撤回时会写入 `segment_revisions`，修改会重置旧反馈和帮助统计。D1 中的限流桶会抽样清理超过 48 小时的数据。生产部署前应先导出 D1 备份，再应用迁移。

## 可信规则（初版）

- 新提交：`trusted`
- 至少 2 个反对票且反对比例高于 50%：`disputed`
- 至少 3 个不同身份举报：`disputed`

规则后续应迁移为可审计的配置，而不是长期硬编码。

## 许可证

服务端代码使用 [AGPL-3.0](LICENSE)。
