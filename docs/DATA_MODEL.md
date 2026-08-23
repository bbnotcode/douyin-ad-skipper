# 数据模型草案

## 本地片段（仅未提交草稿）

```json
{
  "localSegments": {
    "7669344658548047311": [
      {
        "start": 18.5,
        "end": 31.2,
        "title": "视频标题",
        "author": "@作者",
        "url": "https://www.douyin.com/video/7669344658548047311",
        "createdAt": 1785902400000
      }
    ]
  }
}
```

## 共享片段

```json
{
  "id": "seg_01...",
  "videoId": "7669344658548047311",
  "start": 18.5,
  "end": 31.2,
  "category": "sponsor",
  "status": "trusted",
  "upvotes": 2,
  "downvotes": 0,
  "ownedByMe": false,
  "clusterSize": 2,
  "createdAt": "2026-08-05T12:00:00Z"
}
```

服务器不应把视频标题或作者作为主键；作品 ID 与时间范围才是稳定的匹配依据。标题只用于客户端展示和人工审核。

## 状态建议

- `candidate`：旧版本遗留或需要人工复核，只显示标签。
- `trusted`：新提交的默认状态，可以自动跳过。
- `disputed`：争议较大，停止自动跳过。
- `rejected`：恶意、重复或明显错误。

相同作品中高度重叠的片段应复用已有记录，而不是无限创建重复记录。

服务端还保存只用于幂等的 `client_request_id`，并对 `(submitter_hash, client_request_id)` 建立唯一索引。该字段不会在公共查询中返回。

`segment_revisions` 保存投稿者对云端片段执行的修改或撤回操作，包括修改前后的时间和分类。撤回采用 `rejected` 状态而不是直接删除主记录；修改会清理旧投票、举报和帮助统计，使反馈只对应最新边界。
