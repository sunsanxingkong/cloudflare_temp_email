# OAuth2 第三方登录

> [!WARNING] 注意
> 第三方身份使用「Issuer + Client ID + 稳定用户 ID」识别；OIDC 应使用 `sub`。邮箱只是账号属性，不会用于自动合并账号。
>
> 若邮箱已属于站内账号，请先登录该账号，再到「用户设置」显式绑定提供方。新账号需要提供邮箱字段；是否要求 `email_verified=true` 可由管理员单独开启。

## 在第三方平台注册 OAuth2

### GitHub

- 请先创建一个 OAuth App，然后获取 `Client ID` 和 `Client Secret`
- 默认 GitHub 模板使用 `https://api.github.com/user` 作为用户信息接口，并读取返回 JSON 的 `email` 字段。GitHub 账号如果隐藏公开邮箱，该字段会是 `null`，登录会返回 `[400]: 从 Oauth2 提供商获取用户邮箱失败`。
- 解决方式是在 GitHub 个人资料中设置公开邮箱，或改成能返回邮箱的接口/提供商；如果返回值不是标准邮箱，可以使用下方“邮箱格式转换”。

如果不想公开 GitHub 邮箱，可以改用 GitHub 邮箱列表接口：

| 字段 | 值 |
|------|----|
| User Info URL | `https://api.github.com/user/emails` |
| User Email Key | `$[?(@.primary==true)].email` |
| Scope | `user:email` |

GitHub 个人资料中选择了 `Public email` 时，可以继续使用默认的 `https://api.github.com/user` + `email` 配置；只把邮箱从 private 改成可见但没有选择公开邮箱时，`/user` 接口仍可能返回 `email: null`。

参考 [Creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

### Linux Do

- 在 [Linux Do Connect](https://connect.linux.do/) 创建应用获取 `Client ID` 和 `Client Secret`
- Linux Do 返回的是用户 ID 而非邮箱，需要启用邮箱格式转换功能

### Authentik

- [Authentik OAuth2 Provider](https://docs.goauthentik.io/docs/providers/oauth2/)

## Admin 后台配置 OAuth2

![oauth2](/feature/oauth2.png)

### 配置字段说明

| 字段 | 说明 |
|------|------|
| Name | OAuth2 提供商名称，显示在登录页面 |
| Client ID | OAuth2 应用 ID |
| Client Secret | OAuth2 应用密钥 |
| Authorization URL | OAuth2 授权端点 |
| Access Token URL | 获取 Access Token 的端点 |
| Access Token Params Format | Token 请求格式：`json` 或 `urlencoded` |
| User Info URL | 获取用户信息的端点 |
| OIDC Issuer | 提供方 Issuer；可留空，此时使用 UserInfo URL 的 origin |
| User Email Key | 用户信息中邮箱字段的 key，支持 JSONPath (如 `$[0].email`) |
| Stable User ID Key | 稳定用户标识字段；OIDC 填 `sub`，支持 JSONPath |
| Verified Email Claim Key | 邮箱验证状态字段，默认 `email_verified` |
| Require Verified Email | 开启后，新账号只接受验证字段值为 `true` 的用户信息 |
| Redirect URL | OAuth2 回调地址 |
| Scope | OAuth2 权限范围 |

`Redirect URL` 必须和第三方平台 OAuth App 中配置的回调地址完全一致。前端默认回调路径为：

```text
https://你的前端域名/user/oauth2/callback
```

如果你的站点使用语言前缀路由，也仍然建议在 OAuth 平台中配置无语言前缀的回调地址，避免不同语言路径导致回调不一致。

## 身份映射与显式绑定

- OIDC 身份键为 `(Issuer, Client ID, sub)`；邮箱、用户名、显示名称和头像都不会作为身份键。
- 如果该稳定身份尚未关联站内账号，系统可创建新账号（邮箱字段仍需可用）。若邮箱已经属于其他站内账号，系统绝不静默关联：提供方必须返回已验证、未经过邮箱格式转换的邮箱，用户还要在回调页手动确认一次；否则请先登录原账号。
- 登录到原账号后，在「用户设置 → 已绑定的登录方式」点击对应提供方并完成授权，即可显式绑定。绑定流程要求已登录的站内账号，并使用短时、一次性的 OAuth state；不会更改原账号邮箱、地址、角色或 Passkey。
- 旧版 `user_info` 未保存其来源提供方，升级时无法安全推断旧 subject 属于哪个提供方。因此 `v0.0.8` 数据库迁移只创建 `user_oauth_identities` 表，不自动修改或绑定现有账号。旧 OAuth 用户若由提供方验证了同一邮箱，会看到确认页；确认前不会登录旧账号或写入身份映射。确认令牌仅在 KV 中保存 5 分钟且只能使用一次。
- 管理员启用「Require Verified Email」后，只有指定验证字段为布尔值 `true`、字符串 `true` 或 `1` 的新账号才可创建。此项默认关闭，以兼容不提供 `email_verified` 的 OAuth 服务。

用户端身份管理接口：

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/user_api/oauth2/identities` | 需 `x-user-token`；查看当前账号已绑定身份及可用提供方 |
| POST | `/user_api/oauth2/link/start` | 需 `x-user-token`；为指定 `clientID` 发起绑定并取得授权 URL/state |
| POST | `/user_api/oauth2/link/complete` | 需 `x-user-token`；使用 `clientID`、`code`、`state` 完成绑定 |
| POST | `/user_api/oauth2/legacy-link/confirm` | 不需 `x-user-token`；仅接受回调页给出的 5 分钟一次性 `pendingToken`，用于用户确认已验证邮箱对应的旧账号关联 |

### 邮箱格式转换

当 OAuth2 返回的不是标准邮箱格式时（如返回用户 ID），可以启用邮箱格式转换功能。

| 字段 | 说明 |
|------|------|
| Enable Email Format | 启用邮箱格式转换 |
| Email Regex Pattern | 正则表达式，用于匹配原始值，使用捕获组 `()` |
| Replace Template | 替换模板，使用 `$1`、`$2` 等引用捕获组 |

**示例：**

| 场景 | 原始值 | 正则表达式 | 替换模板 | 结果 |
|------|--------|-----------|----------|------|
| ID 转邮箱 | `12345` | `^(.+)$` | `linux_do_$1@oauth.linux.do` | `linux_do_12345@oauth.linux.do` |
| 换域名 | `john@old.com` | `^(.+)@old\.com$` | `$1@new.com` | `john@new.com` |
| 提取用户名 | `john@corp.com` | `^(.+)@.*$` | `$1@mymail.com` | `john@mymail.com` |

### 邮件地址白名单

启用后，只有指定域名的邮箱才能登录。

## 测试用户登录页面

![oauth2 login](/feature/oauth2-login.png)
