# TEID-UI-1 implementation notes

- The console is a hash-routed, static ES-module application. `index.html`
  contains only the persistent brand/nav region and one content mount point;
  sign-in renders into that mount before the authenticated nav is exposed.
- MFA enrollment shows the returned `otpauth_uri` as copyable text. A QR
  encoder was intentionally not added because the URI satisfies the contract
  and keeps the frontend dependency-free.
- Discrepancy evidence uses an adjacent expandable table row. It renders only
  the evidence object retained with the report row; expanding it never invokes
  `apiFetch`.
- Excluded customers and caveats live in a separate `section` with a distinct
  data marker, heading, background, and "not included" badge. They are never
  inserted into the mapped table or totals strip.
- Customer plan/balance is represented by the current subscription plus each
  grant's server-returned `remaining_amount`. No aggregate balance is calculated
  in the browser. Finance and Support render only the timeline and do not call
  customer detail, subscription, or grants endpoints.
- The existing API-key and new session populations both need the exact same
  `GET /customers` paths. Fastify cannot mount duplicate method/path pairs, so
  those two reads use one dual-auth pre-handler, following the existing timeline
  route's established pattern. The data queries are extracted once and both
  caller types use those functions; API-key write routes and behavior are
  unchanged. The session roles are still recorded in `CONSOLE_ROUTE_AUDIT`.
- The spec's Support statements conflict: its matrix/AC9 opens Audit Log to all
  roles, while T3 says Support's nav must contain only the customer timeline.
  The implementation satisfies both observable behaviors by allowing a Support
  user to navigate directly to Audit Log (the backend permits it) while keeping
  Support's primary nav timeline-only.
- Period-close mutations are absent from the Finance DOM. Owner/Billing Admin
  actions submit the calendar month's UTC start and following-month boundary.
- API-key plaintext exists only in the create/rotate response local variable and
  a transient dialog. Closing the dialog clears its text node and removes it;
  list/detail views render only `display_hint`.
- Audit CSV uses the existing export endpoint. The visible anchor has that
  endpoint as its `href`; its click is fulfilled through the shared authenticated
  fetch helper so the Bearer-only backend can authorize the download.
- Tests include live authentication coverage and jsdom DOM/interaction coverage.
  The report fixtures deliberately retain decimal strings and T6 compares DOM
  text directly to those response strings. T12 scans shipped JavaScript and also
  exercises the rendered disconnect button's request method/path.
