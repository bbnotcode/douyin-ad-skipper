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
