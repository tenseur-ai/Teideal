import { definitionList, element, errorRegion, field, formButton, selectInput, setError, statusRegion, textInput } from "./shared.js";

function showOneTimeKey(host, key) {
  const dialog = element("dialog", { className: "secret-dialog", "aria-labelledby": "secret-title" });
  const title = element("h2", { id: "secret-title", text: "Copy your API key now" });
  const notice = element("p", { text: "This plaintext key will not be shown again." });
  const secret = element("code", { className: "one-time-secret", text: key });
  const close = element("button", { type: "button", className: "button", text: "I have copied it" });
  close.addEventListener("click", () => { secret.textContent = ""; dialog.close?.(); dialog.remove(); });
  dialog.append(title, notice, secret, close);
  host.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
}

export function apiKeysPanel(ctx) {
  const section = element("section", { className: "panel" });
  const error = errorRegion();
  const status = statusRegion();
  const list = element("div", { className: "card-grid" });
  const form = element("form", { className: "inline-form api-key-form" });
  const label = textInput("label", "Integration name"); label.required = true;
  const scope = selectInput("scope", ["ingest-only", "read-only", "admin"], "read-only");
  const environment = selectInput("environment", ["sandbox", "production"], ctx.principal.role === "Developer" ? "sandbox" : "production");
  form.append(field("Label", label), field("Scope", scope), field("Environment", environment), formButton("Create API key"));
  section.append(element("div", { className: "panel-heading" }, [element("h2", { text: "API keys" })]), error, status, form, list);

  async function load() {
    const result = await ctx.apiFetch("/api-keys");
    list.replaceChildren();
    for (const key of result.data ?? []) {
      const card = element("article", { className: "api-key-card", dataset: { keyId: key.id } }, [
        element("div", { className: "panel-heading" }, [element("h3", { text: key.label }), element("span", { className: "section-tag", text: key.status })]),
        definitionList([["Display hint", key.display_hint], ["Scope", key.scope], ["Environment", key.environment], ["Created", key.created_at]]),
      ]);
      const detail = element("div", { className: "key-detail" });
      const buttons = element("div", { className: "button-row" }, [
        element("button", { type: "button", className: "button secondary", text: "Details", onclick: async () => {
          try {
            const loaded = await ctx.apiFetch(`/api-keys/${key.id}`);
            detail.replaceChildren(definitionList([["Display hint", loaded.display_hint], ["Scope", loaded.scope], ["Environment", loaded.environment], ["Status", loaded.status]]));
          } catch (caught) { setError(error, caught); }
        } }),
        element("button", { type: "button", className: "button secondary", text: "Rotate", onclick: async () => {
          try {
            const rotated = await ctx.apiFetch(`/api-keys/${key.id}/rotate`, { method: "POST", body: JSON.stringify({ grace_period_hours: 24 }) });
            showOneTimeKey(section, rotated.key); await load();
          } catch (caught) { setError(error, caught); }
        } }),
        element("button", { type: "button", className: "button danger", text: "Revoke", onclick: async () => {
          try { await ctx.apiFetch(`/api-keys/${key.id}/revoke`, { method: "POST" }); status.textContent = "API key revoked."; await load(); }
          catch (caught) { setError(error, caught); }
        } }),
      ]);
      card.append(buttons, detail); list.append(card);
    }
    if (!result.data?.length) list.append(element("p", { className: "empty-state", text: "No API keys." }));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault(); error.hidden = true;
    try {
      const created = await ctx.apiFetch("/api-keys", { method: "POST", body: JSON.stringify({ label: label.value, scope: scope.value, environment: environment.value }) });
      showOneTimeKey(section, created.key); form.reset();
      if (ctx.principal.role === "Developer") environment.value = "sandbox";
      await load();
    } catch (caught) { setError(error, caught); }
  });
  load().catch((caught) => setError(error, caught));
  return section;
}
