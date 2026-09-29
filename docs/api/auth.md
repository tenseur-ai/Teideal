# Authentication, users, API keys, and tenant settings

Console-session routes use `Authorization: Bearer $SESSION_TOKEN`. API keys
are returned in plaintext only by create/rotate; store them immediately.

## GET /auth/sso-status [ts-console]

- **Auth:** Public.
- **Request:** Query `tenant_key`.
- **Response:** `200 {tenant_key,sso_enabled}`.
- **Errors:** `400` missing key; `404` unknown account.

```bash
curl "$TS_CONSOLE_URL/auth/sso-status?tenant_key=acct_1001"
```

## POST /auth/login [ts-console]

- **Auth:** Public credentials.
- **Request:** JSON `tenant_key`, `email`, `password`.
- **Response:** `200` authenticated session, MFA challenge, or enrollment challenge.
- **Errors:** `400` missing fields; `401` invalid credentials; `423` locked account.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/login" -H 'content-type: application/json' -d '{"tenant_key":"acct_1001","email":"developer@acmeco.com","password":"DeveloperPass123!"}'
```

## POST /auth/login/google [ts-console]

- **Auth:** Public Google identity token.
- **Request:** JSON `tenant_key`, `id_token`.
- **Response:** `200` session or MFA challenge.
- **Errors:** `400` missing fields; `401` rejected identity; `403` SSO disabled; `504` Google timeout.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/login/google" -H 'content-type: application/json' -d '{"tenant_key":"acct_1001","id_token":"$GOOGLE_ID_TOKEN"}'
```

## POST /auth/mfa/verify [ts-console]

- **Auth:** Public pending-login token in the body.
- **Request:** JSON `pending_token`, `totp_code`.
- **Response:** `200 {status:"authenticated",session_token}`.
- **Errors:** `400` missing fields; `401` invalid/expired token or code.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/mfa/verify" -H 'content-type: application/json' -d '{"pending_token":"$PENDING_TOKEN","totp_code":"123456"}'
```

## POST /auth/mfa/enroll/confirm [ts-console]

- **Auth:** Public MFA-enrollment pending token.
- **Request:** JSON `pending_token`, `totp_code` generated from the offered URI.
- **Response:** `200` authenticated session.
- **Errors:** `400` missing fields; `401` invalid/expired token or code.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/mfa/enroll/confirm" -H 'content-type: application/json' -d '{"pending_token":"$PENDING_TOKEN","totp_code":"123456"}'
```

## POST /auth/mfa/reset [ts-console]

- **Auth:** Any signed-in user (self-service).
- **Request:** JSON `totp_code` from the current MFA method.
- **Response:** `200 {otpauth_uri}` for the replacement secret.
- **Errors:** `400` MFA not enrolled; `401` missing/invalid session or current code.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/mfa/reset" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"totp_code":"123456"}'
```

## POST /auth/mfa/reset/confirm [ts-console]

- **Auth:** Any signed-in user (self-service).
- **Request:** JSON `totp_code` from the replacement secret.
- **Response:** `200 {}` and activates the replacement.
- **Errors:** `401` missing/invalid session or code.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/mfa/reset/confirm" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"totp_code":"123456"}'
```

## POST /auth/mfa/disable [ts-console]

- **Auth:** Signed-in non-mandatory role.
- **Request:** JSON `totp_code` as step-up proof.
- **Response:** `200 {}`.
- **Errors:** `401` invalid code/session; `403` role requires MFA.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/mfa/disable" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"totp_code":"123456"}'
```

## POST /auth/logout [ts-console]

- **Auth:** Any signed-in user.
- **Request:** Empty body.
- **Response:** `200 {}`; the current session is deleted.
- **Errors:** `401` missing/invalid session.

```bash
curl -X POST "$TS_CONSOLE_URL/auth/logout" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /users [ts-console]

- **Auth:** Owner session.
- **Request:** JSON `email`, `password`, `role`.
- **Response:** `201` user metadata without password material.
- **Errors:** `400` invalid/missing fields or role; `409` email already exists; `403` wrong role.

```bash
curl -X POST "$TS_CONSOLE_URL/users" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"email":"new@example.test","password":"StrongPass123!","role":"Developer"}'
```

## GET /users [ts-console]

- **Auth:** Owner session.
- **Request:** No body.
- **Response:** `200 {data:[{id,email,role,mfa_enrolled,created_at}]}`.
- **Errors:** `401` invalid session; `403` wrong role.

```bash
curl "$TS_CONSOLE_URL/users" -H "authorization: Bearer $SESSION_TOKEN"
```

## PATCH /users/:id/role [ts-console]

- **Auth:** Owner session.
- **Request:** Path user UUID; JSON `role`.
- **Response:** `200` updated user.
- **Errors:** `400` invalid role; `403` wrong role, hidden user, or forbidden self-change.

```bash
curl -X PATCH "$TS_CONSOLE_URL/users/$USER_ID/role" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"role":"Finance"}'
```

## DELETE /users/:id [ts-console]

- **Auth:** Owner session.
- **Request:** Path user UUID.
- **Response:** `200` deleted user metadata.
- **Errors:** `403` wrong role, hidden user, or forbidden self-delete.

```bash
curl -X DELETE "$TS_CONSOLE_URL/users/$USER_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## PATCH /tenant-settings [ts-console]

- **Auth:** Owner session.
- **Request:** Any of `require_mfa_all_roles` (boolean), `idle_timeout_minutes` (positive number), `sso_enabled` (boolean).
- **Response:** `200` saved settings.
- **Errors:** `400` invalid field type/value; `403` wrong role.

```bash
curl -X PATCH "$TS_CONSOLE_URL/tenant-settings" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"idle_timeout_minutes":60}'
```

## POST /api-keys [ts-console]

- **Auth:** Owner or Developer session.
- **Request:** JSON `scope` (`ingest-only`, `read-only`, `admin`), `environment`, `label`; optional visible `customer_id`.
- **Response:** `201` metadata plus one-time `key`.
- **Errors:** `400` invalid fields; `403` wrong role or hidden customer.

```bash
curl -X POST "$TS_CONSOLE_URL/api-keys" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"scope":"admin","environment":"sandbox","label":"example"}'
```

## GET /api-keys [ts-console]

- **Auth:** Any console role.
- **Request:** Optional `limit` (1–200) and UUID `cursor`.
- **Response:** `200 {data,cursor}` with masked display hints, never plaintext keys.
- **Errors:** `400` invalid pagination; `401` invalid session.

```bash
curl "$TS_CONSOLE_URL/api-keys?limit=50" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /api-keys/:id [ts-console]

- **Auth:** Any console role.
- **Request:** Path key UUID.
- **Response:** `200` masked key metadata.
- **Errors:** `400` invalid UUID; `404` no visible key.

```bash
curl "$TS_CONSOLE_URL/api-keys/$KEY_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /api-keys/:id/rotate [ts-console]

- **Auth:** Owner or Developer session.
- **Request:** Path key UUID; optional JSON `grace_period_hours` (positive, default 24).
- **Response:** `201` replacement metadata plus its one-time plaintext `key`.
- **Errors:** `400` invalid UUID/grace period; `403` wrong role or hidden key.

```bash
curl -X POST "$TS_CONSOLE_URL/api-keys/$KEY_ID/rotate" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"grace_period_hours":24}'
```

## POST /api-keys/:id/revoke [ts-console]

- **Auth:** Owner or Developer session.
- **Request:** Path key UUID; empty body.
- **Response:** `200` revoked masked metadata.
- **Errors:** `400` invalid UUID; `403` wrong role or hidden key.

```bash
curl -X POST "$TS_CONSOLE_URL/api-keys/$KEY_ID/revoke" -H "authorization: Bearer $SESSION_TOKEN"
```

