# Sandbox tenants and plan promotion

Sandbox tenants are isolated children of production tenants and can connect
only test-mode processor accounts.

## POST /tenants/:id/sandbox [ts-console]

- **Auth:** Owner session for the production tenant.
- **Request:** Production tenant UUID; empty body.
- **Response:** `201 {sandbox_tenant_id,api_key}`; plaintext initial sandbox key appears once.
- **Errors:** `400` invalid UUID/non-production parent; `403` foreign tenant; `404` tenant missing; `409` sandbox exists.

```bash
curl -X POST "$TS_CONSOLE_URL/tenants/$TENANT_ID/sandbox" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /tenants/:id [ts-console]

- **Auth:** Any console role in the tenant or its production parent.
- **Request:** Tenant UUID.
- **Response:** `200 {id,kind,parent_tenant_id}`.
- **Errors:** `400` invalid UUID; `404` hidden/missing tenant.

```bash
curl "$TS_CONSOLE_URL/tenants/$SANDBOX_ID" -H "authorization: Bearer $SESSION_TOKEN"
```

## GET /tenants/:id/sandbox/promote-plans/preview [ts-console]

- **Auth:** Owner or Billing Admin session in the production parent.
- **Request:** Sandbox tenant UUID.
- **Response:** `200` unpromoted sandbox plans and source/target tenant IDs.
- **Errors:** `400` invalid UUID; `403` hidden sandbox.

```bash
curl "$TS_CONSOLE_URL/tenants/$SANDBOX_ID/sandbox/promote-plans/preview" -H "authorization: Bearer $SESSION_TOKEN"
```

## POST /tenants/:id/sandbox/promote-plans [ts-console]

- **Auth:** Owner or Billing Admin session in the production parent.
- **Request:** Sandbox tenant UUID; JSON `plan_ids` array of sandbox plan UUIDs.
- **Response:** `200` source-to-created-plan mappings.
- **Errors:** `400` invalid UUID/list; `403` hidden sandbox; `404` source plan missing; `409` already promoted/name conflict.

```bash
curl -X POST "$TS_CONSOLE_URL/tenants/$SANDBOX_ID/sandbox/promote-plans" -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: application/json' -d '{"plan_ids":["'$PLAN_ID'"]}'
```

