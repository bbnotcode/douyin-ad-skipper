# 社区共享 API 草案

本文档描述当前公共服务接口。

## 查询片段

```http
GET /v1/videos/{videoId}/segments
```

响应：

```json
{
  "videoId": "7669344658548047311",
  "segments": [
    {
      "id": "seg_01...",
      "start": 18.5,
      "end": 31.2,
      "category": "sponsor",
      "status": "trusted",
      "score": 0.92
    }
  ]
}
```

扩展正常播放查询使用隐私版本：

```http
GET /v1/videos/by-hash/{sha256(videoId)}/segments
```

原始作品 ID 查询仅保留用于旧客户端兼容和迁移。

## 提交片段

```http
POST /v1/segments
Content-Type: application/json
```

```json
{
  "videoId": "7669344658548047311",
  "start": 18.5,
  "end": 31.2,
  "category": "sponsor",
  "duration": 585.0,
  "clientRequestId": "随机 UUID"
}
```

服务端必须校验数值范围、片段长度、视频时长、重复请求和提交速率。

## 我的社区片段

```http
GET /v1/me/segments
X-Client-ID: 匿名贡献者 UUID
```

返回该匿名贡献者已提交的片段，以及 `submittedCount` 和 `contributedSeconds`。服务端只使用 `X-Client-ID` 的加盐哈希查询，不保存原始值。

统计中还包含：

- `skipCount`：这些片段实际被其他匿名用户跳过的次数；
- `helpedPeople`：去重后的匿名用户数；
- `secondsSaved`：实际累计节省秒数。

## 记录一次有效跳过

```http
POST /v1/segments/{segmentId}/skips
X-Client-ID: 匿名贡献者 UUID
```

同一匿名用户对同一片段每天最多计入一次，提交者自己跳过自己的片段不计入。

## 投票

```http
POST /v1/segments/{segmentId}/votes
```

```json
{ "vote": 1 }
```

`vote` 只能为 `1` 或 `-1`。同一匿名客户端对同一片段只能保留一个当前投票。

## 举报

```http
POST /v1/segments/{segmentId}/reports
```

举报原因应使用有限枚举：`wrong_video`、`wrong_time`、`not_ad`、`abuse`、`other`。

## 防滥用最低要求

- IP 与匿名客户端双层限流；
- 请求体 Schema 校验；
- 幂等请求 ID；
- 审核日志；
- 不向客户端暴露提交者 IP；
- 合法提交可立即成为可信片段；社区反对、举报和管理员操作用于事后纠错。
