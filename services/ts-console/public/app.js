export const SESSION_KEY = "teideal_console_session";

const app = document.querySelector("#app");
const nav = document.querySelector("#primary-nav");
const summary = document.querySelector("#session-summary");

let principal = null;
const today = new Date();
let selectedMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
let renderingSignIn = false;

const screens = {
  home: { label: "Home", roles: ["Owner", "Billing Admin"], module: "./screens/home.js" },
  report: { label: "Discrepancy report", roles: ["Owner", "Billing Admin", "Finance"], module: "./screens/report.js" },
  customer: { label: "Customer", roles: ["Owner", "Billing Admin", "Finance", "Support"], module: "./screens/customer.js" },
  contract: { label: "Contract", roles: ["Owner", "Billing Admin"], module: "./screens/contract.js" },
  stripe: { label: "Stripe", roles: ["Owner", "Billing Admin"], module: "./screens/stripe.js" },
  "period-close": { label: "Period close", roles: ["Owner", "Billing Admin", "Finance"], module: "./screens/periodClose.js" },
  audit: { label: "Audit log", roles: ["Owner", "Billing Admin", "Finance", "Support", "Developer"], hideNavFor: ["Support"], module: "./screens/auditLog.js" },
  access: { label: "Users & API keys", roles: ["Owner", "Billing Admin", "Developer"], module: "./screens/users.js" },
};

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function publicFetch(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const body = await parseResponse(response);
  if (!response.ok) throw new ApiError(response.status, body?.error ?? `Request failed (${response.status})`, body);
  return body;
}

export async function apiFetch(path, options = {}) {
  const { responseType, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers ?? {});
  const token = sessionStorage.getItem(SESSION_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (fetchOptions.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...fetchOptions, headers });
  const body = response.ok && responseType === "blob" ? await response.blob() : await parseResponse(response);
  if (response.status === 401) {
    sessionStorage.removeItem(SESSION_KEY);
    principal = null;
    nav.replaceChildren();
    nav.hidden = true;
    summary.replaceChildren();
    app.replaceChildren();
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    renderSignIn();
    throw new ApiError(401, body?.error ?? "Your session expired. Sign in again.", body);
  }
  if (!response.ok) throw new ApiError(response.status, body?.error ?? `Request failed (${response.status})`, body);
  return body;
}

function storeSession(result) {
  if (!result?.session_token) throw new Error("Sign-in response did not include a session token.");
  sessionStorage.setItem(SESSION_KEY, result.session_token);
}

function authForm(title, description) {
  app.replaceChildren();
  const card = document.createElement("section");
  card.className = "auth-card";
  const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "Secure operator access";
  const heading = document.createElement("h1"); heading.textContent = title;
  const copy = document.createElement("p"); copy.className = "lede"; copy.textContent = description;
  const error = document.createElement("div"); error.className = "inline-error"; error.hidden = true; error.setAttribute("role", "alert");
  card.append(eyebrow, heading, copy, error);
  app.append(card);
  return { card, error };
}

function authInput(labelText, name, type = "text") {
  const label = document.createElement("label"); label.className = "field";
  const text = document.createElement("span"); text.textContent = labelText;
  const input = document.createElement("input"); input.name = name; input.type = type; input.required = true;
  label.append(text, input);
  return { label, input };
}

function showAuthError(node, error) {
  node.textContent = error instanceof Error ? error.message : String(error);
  node.hidden = false;
}

function renderTotpChallenge(result, enrollment) {
  const { card, error } = authForm(
    enrollment ? "Set up multi-factor authentication" : "Enter your authentication code",
    enrollment ? "Add this URI to your authenticator, then enter the six-digit code." : "Use the current code from your authenticator app.",
  );
  if (enrollment) {
    const uri = document.createElement("code"); uri.className = "otpauth-uri"; uri.textContent = result.otpauth_uri;
    card.append(uri);
  }
  const form = document.createElement("form"); form.className = "stack";
  const code = authInput("TOTP code", "totp_code", "text");
  code.input.inputMode = "numeric"; code.input.autocomplete = "one-time-code";
  const submit = document.createElement("button"); submit.className = "button"; submit.type = "submit"; submit.textContent = enrollment ? "Confirm enrollment" : "Verify code";
  form.append(code.label, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); error.hidden = true; submit.disabled = true;
    try {
      const path = enrollment ? "/auth/mfa/enroll/confirm" : "/auth/mfa/verify";
      const authenticated = await publicFetch(path, {
        method: "POST",
        body: JSON.stringify({ pending_token: result.pending_token, totp_code: code.input.value }),
      });
      storeSession(authenticated);
      await loadConsole();
    } catch (caught) { showAuthError(error, caught); } finally { submit.disabled = false; }
  });
  card.append(form);
  code.input.focus();
}

export function renderSignIn(message = "Sign in with your tenant account to continue.") {
  if (renderingSignIn) return;
  renderingSignIn = true;
  nav.hidden = true;
  const { card, error } = authForm("Welcome back", message);
  const form = document.createElement("form"); form.className = "stack";
  const tenant = authInput("Tenant key", "tenant_key"); tenant.input.autocomplete = "organization";
  const email = authInput("Email", "email", "email"); email.input.autocomplete = "username";
  const password = authInput("Password", "password", "password"); password.input.autocomplete = "current-password";
  const submit = document.createElement("button"); submit.className = "button"; submit.type = "submit"; submit.textContent = "Sign in";
  form.append(tenant.label, email.label, password.label, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); error.hidden = true; submit.disabled = true;
    try {
      const result = await publicFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ tenant_key: tenant.input.value, email: email.input.value, password: password.input.value }),
      });
      if (result.status === "authenticated") {
        storeSession(result);
        await loadConsole();
      } else if (result.status === "mfa_required") {
        renderingSignIn = false;
        renderTotpChallenge(result, false);
      } else if (result.status === "mfa_enrollment_required") {
        renderingSignIn = false;
        renderTotpChallenge(result, true);
      } else {
        throw new Error("Sign-in returned an unsupported status.");
      }
    } catch (caught) { showAuthError(error, caught); } finally { submit.disabled = false; }
  });
  card.append(form);
  renderingSignIn = false;
  tenant.input.focus();
}

function allowedScreens() {
  return Object.entries(screens).filter(([, screen]) => screen.roles.includes(principal.role));
}

function renderNav() {
  nav.replaceChildren();
  for (const [key, screen] of allowedScreens().filter(([, item]) => !item.hideNavFor?.includes(principal.role))) {
    const link = document.createElement("a");
    link.href = `#${key}`;
    link.dataset.screen = key;
    link.textContent = screen.label;
    nav.append(link);
  }
  nav.hidden = false;
  const badge = document.createElement("span"); badge.className = "role-badge"; badge.textContent = principal.role;
  const signOut = document.createElement("button"); signOut.type = "button"; signOut.className = "link-button"; signOut.textContent = "Sign out";
  signOut.addEventListener("click", async () => {
    try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* local sign-out still completes */ }
    sessionStorage.removeItem(SESSION_KEY); principal = null; nav.hidden = true; summary.replaceChildren(); renderSignIn("You have signed out.");
  });
  summary.replaceChildren(badge, signOut);
}

function ctx() {
  return {
    apiFetch,
    principal,
    getMonth: () => selectedMonth,
    setMonth: (month) => { selectedMonth = month; },
    navigate: (screen) => { location.hash = screen; },
  };
}

export async function route() {
  if (!principal) return;
  const allowed = allowedScreens();
  let key = location.hash.slice(1).split("?")[0];
  if (!allowed.some(([candidate]) => candidate === key)) key = allowed[0]?.[0] ?? "customer";
  for (const link of nav.querySelectorAll("a")) link.toggleAttribute("aria-current", link.dataset.screen === key);
  const screen = screens[key];
  app.replaceChildren();
  app.setAttribute("aria-busy", "true");
  try {
    const module = await import(screen.module);
    await module.render(app, ctx());
  } catch (error) {
    if (error?.status !== 401) {
      const alert = document.createElement("div"); alert.className = "inline-error page-error"; alert.setAttribute("role", "alert"); alert.textContent = error instanceof Error ? error.message : String(error);
      app.replaceChildren(alert);
    }
  } finally { app.removeAttribute("aria-busy"); app.focus(); }
}

export async function loadConsole() {
  principal = await apiFetch("/auth/me");
  renderingSignIn = false;
  renderNav();
  if (!location.hash) location.hash = principal.role === "Support" ? "customer" : allowedScreens()[0][0];
  await route();
}

export async function init() {
  window.addEventListener("hashchange", route);
  if (!sessionStorage.getItem(SESSION_KEY)) renderSignIn();
  else {
    try { await loadConsole(); } catch (error) { if (error?.status !== 401) renderSignIn(error.message); }
  }
}

if (app && nav && summary) init();
