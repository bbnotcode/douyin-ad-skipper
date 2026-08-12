# 安全政策

## 支持范围

项目仍处于早期阶段，安全修复只保证优先应用于最新版本。报告问题前请先在 `chrome://extensions` 确认版本号，并避免在生产社区 API 上进行批量或破坏性测试。

## 报告漏洞

请不要为以下问题直接创建公开 Issue：

- 能泄露用户身份、Cookie 或本地片段的数据漏洞；
- 可执行任意脚本或绕过扩展内容安全策略的问题；
- 未来共享 API 中的认证、越权、批量滥用或数据删除漏洞。

在 GitHub 仓库启用 Private vulnerability reporting 后，请使用仓库 Security 页面私下报告。在该功能启用前，请联系仓库维护者，并只提供最少必要信息。

私密报告入口：https://github.com/bbnotcode/douyin-ad-skipper/security/advisories/new

报告中请包含受影响版本、复现步骤、影响和建议修复方式。请勿访问他人数据或进行破坏性测试。

## 安全边界

- `X-Client-ID` 是匿名贡献标识，不是认证令牌；不得用于保存或授权敏感数据。
- 社区 API 是公开服务，主要通过输入校验、请求体限制、身份/IP 限流和社区纠错降低滥用风险。
- `.dev.vars`、Cloudflare 密钥、数据库导出和浏览器 Cookie 不得提交到仓库或 Issue。
- 扩展发布包只包含运行所需文件，不包含 Worker 配置、数据库迁移或本地开发文件。
