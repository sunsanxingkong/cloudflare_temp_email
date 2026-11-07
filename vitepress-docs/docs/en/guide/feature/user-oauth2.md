# OAuth2 Third-Party Login

> [!WARNING] Note
> Third-party identity is keyed by `Issuer + Client ID + stable user ID`; OIDC providers should use `sub`. Email is an account attribute and is never used to auto-merge accounts.
>
> If an email already belongs to a site account, sign in to that account first and explicitly link the provider under User Settings. New accounts need an email claim; requiring `email_verified=true` is an optional provider setting.

## Register OAuth2 on Third-Party Platforms

### GitHub

- Please first create an OAuth App, then obtain the `Client ID` and `Client Secret`
- The default GitHub template uses `https://api.github.com/user` as the user info endpoint and reads
  the `email` field from the returned JSON. If the GitHub account hides its public email, this field
  is `null`, and login returns `[400]: Failed to get user email from OAuth2 provider`.
- Fix it by making the email public in the GitHub profile, or by using a provider/API that returns
  an email field. If the returned value is not a standard email, use the "Email Format
  Transformation" section below.

If you do not want to expose a public GitHub email, use the GitHub email list API instead:

| Field | Value |
|-------|-------|
| User Info URL | `https://api.github.com/user/emails` |
| User Email Key | `$[?(@.primary==true)].email` |
| Scope | `user:email` |

When a `Public email` is selected in the GitHub profile, the default `https://api.github.com/user`
endpoint with `User Email Key = email` can still be used. Merely changing an email from private to
visible without selecting it as the public email can still make the `/user` API return `email: null`.

Reference: [Creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

### Linux Do

- Create an application at [Linux Do Connect](https://connect.linux.do/) to obtain `Client ID` and `Client Secret`
- Linux Do returns a user ID instead of an email, so you need to enable the Email Format feature

### Authentik

- [Authentik OAuth2 Provider](https://docs.goauthentik.io/docs/providers/oauth2/)

## Configure OAuth2 in Admin Backend

![oauth2](/feature/oauth2.png)

### Configuration Fields

| Field | Description |
|-------|-------------|
| Name | OAuth2 provider name, displayed on the login page |
| Client ID | OAuth2 application ID |
| Client Secret | OAuth2 application secret |
| Authorization URL | OAuth2 authorization endpoint |
| Access Token URL | Endpoint to obtain Access Token |
| Access Token Params Format | Token request format: `json` or `urlencoded` |
| User Info URL | Endpoint to get user information |
| OIDC Issuer | Provider issuer; optional, defaults to the UserInfo URL origin |
| User Email Key | Key for email field in user info, supports JSONPath (e.g., `$[0].email`) |
| Stable User ID Key | Stable provider identifier; use `sub` for OIDC; supports JSONPath |
| Verified Email Claim Key | Email verification claim key; defaults to `email_verified` |
| Require Verified Email | When enabled, new accounts require the verification claim to be `true` |
| Redirect URL | OAuth2 callback URL |
| Scope | OAuth2 permission scope |

`Redirect URL` must exactly match the callback URL configured in the third-party OAuth App. The
default frontend callback path is:

```text
https://your-frontend-domain/user/oauth2/callback
```

Even if your site uses locale-prefixed routes, it is still recommended to configure the OAuth
provider with the callback URL without a locale prefix to avoid callback mismatches between
languages.

## Identity Mapping and Explicit Linking

- OIDC identity keys are `(Issuer, Client ID, sub)`. Email, username, display name, and avatar are never identity keys.
- When a stable identity is not linked, the site can create a new account if an email claim is available. If that email already belongs to another site account, it is never linked silently: the provider must return a verified, untransformed email, and the user must confirm once on the callback page; otherwise, sign in to the existing account first.
- After signing in, open **User Settings → Linked Login Methods**, choose the provider, and complete authorization to explicitly link it. The flow requires an authenticated site account and uses a short-lived, single-use OAuth state. It does not change the site's email, addresses, roles, or passkeys.
- Legacy `user_info` did not record its source provider, so old subjects cannot be safely attributed during migration. The `v0.0.8` migration only creates `user_oauth_identities`; it does not update or link existing accounts. A legacy OAuth user whose provider verifies the same email sees a confirmation page; no old-account login or identity write occurs before the user confirms. The confirmation token is stored in KV for five minutes and is single-use.
- If **Require Verified Email** is enabled, a new account is created only when the configured claim is boolean `true`, string `true`, or `1`. This option defaults to off for compatibility with providers that do not return `email_verified`.

User identity-management endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/user_api/oauth2/identities` | Requires `x-user-token`; list the signed-in user's linked identities and configured providers |
| POST | `/user_api/oauth2/link/start` | Requires `x-user-token`; start linking for a `clientID` and return an authorization URL/state |
| POST | `/user_api/oauth2/link/complete` | Requires `x-user-token`; complete linking with `clientID`, `code`, and `state` |
| POST | `/user_api/oauth2/legacy-link/confirm` | Does not require `x-user-token`; accepts only the callback page's five-minute, single-use `pendingToken` to confirm linking to an account with the verified email |

### Email Format Transformation

When OAuth2 returns a non-standard email format (e.g., returns a user ID), you can enable the Email Format feature.

| Field | Description |
|-------|-------------|
| Enable Email Format | Enable email format transformation |
| Email Regex Pattern | Regular expression to match the original value, use capture groups `()` |
| Replace Template | Replacement template, use `$1`, `$2`, etc. to reference capture groups |

**Examples:**

| Scenario | Original Value | Regex Pattern | Replace Template | Result |
|----------|---------------|---------------|------------------|--------|
| ID to Email | `12345` | `^(.+)$` | `linux_do_$1@oauth.linux.do` | `linux_do_12345@oauth.linux.do` |
| Change Domain | `john@old.com` | `^(.+)@old\.com$` | `$1@new.com` | `john@new.com` |
| Extract Username | `john@corp.com` | `^(.+)@.*$` | `$1@mymail.com` | `john@mymail.com` |

### Email Address Allow List

When enabled, only emails from specified domains can login.

## Test User Login Page

![oauth2 login](/feature/oauth2-login.png)
