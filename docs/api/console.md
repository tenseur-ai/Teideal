# Integrated operator console

The browser console is served by `ts-console` itself. Its static shell is
public; every data request made after sign-in remains protected by the
documented session-gated API routes.

## GET / [ts-console]

- **Auth:** Public.
- **Request:** No body.
- **Response:** Redirect to `/console/`.
- **Errors:** Standard static-serving errors only.

```bash
curl -I "$TS_CONSOLE_URL/"
```

## GET /console/* [ts-console]

- **Auth:** Public static asset; API data remains session-gated.
- **Request:** A console asset path such as `/console/` or `/console/app.js`.
- **Response:** `200` static HTML, CSS, or JavaScript.
- **Errors:** `404` unknown asset.

```bash
curl "$TS_CONSOLE_URL/console/"
```
