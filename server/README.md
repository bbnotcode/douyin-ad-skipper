# 社区共享服务端

Cloudflare Workers + D1 的社区片段 API。新片段默认是 `candidate`，达到投票阈值后才会变成 `trusted`。

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
3. 首次部署：`npm run deploy`。Wrangler 会自动配置 `DB` 绑定。
4. 应用远程迁移：`npm run db:migrate:remote`。
5. 将 Worker 的 HTTPS 地址填写到扩展“社区共享”设置页并授权。

生产环境必须设置 `CLIENT_HASH_SALT`，否则所有写接口返回 `503`。不要提交 `.dev.vars`。

## 接口

- `GET /health`
- `GET /v1/videos/:videoId/segments`
- `POST /v1/segments`
- `POST /v1/segments/:segmentId/votes`
- `POST /v1/segments/:segmentId/reports`

写请求必须携带随机生成的 `X-Client-ID`。服务端只保存客户端 ID 与 IP 组合后的不可逆哈希，不保存原值。

## 可信规则（初版）

- 新提交：`candidate`
- 至少 2 个赞成票且赞成比例不低于 75%：`trusted`
- 至少 2 个反对票且反对比例高于 50%：`disputed`
- 至少 3 个不同身份举报：`disputed`

规则后续应迁移为可审计的配置，而不是长期硬编码。

## 许可证

服务端代码使用 [AGPL-3.0](LICENSE)。
