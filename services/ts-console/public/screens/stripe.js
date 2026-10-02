import { clear, definitionList, element, errorRegion, field, formButton, jsonBlock, pageHeader, setError, statusRegion, textInput } from "./shared.js";

export async function render(container, ctx) {
  clear(container);
  const error = errorRegion();
  const status = statusRegion();
  const health = element("section", { className: "panel" });
  const connect = element("section", { className: "panel" }, [element("div", { className: "panel-heading" }, [element("h2", { text: "Stripe Connect" }), element("span", { className: "section-tag", text: "Read only" })])]);
  const authorize = element("button", { type: "button", className: "button", text: "Connect Stripe read-only" });
  const callback = element("form", { className: "inline-form" });
  const code = textInput("code", "OAuth code"); const state = textInput("state", "Signed state");
  callback.append(field("OAuth code", code), field("State", state), formButton("Complete connection", "button secondary"));
  connect.append(authorize, callback);

  const register = element("form", { className: "inline-form" });
  const connectionId = textInput("stripe_connection_id", "Stripe connection UUID"); connectionId.required = true;
  const displayName = textInput("display_name", "Stripe Billing"); displayName.required = true;
  register.append(field("Connection ID", connectionId), field("Display name", displayName), formButton("Register connector"));
  connect.append(element("h3", { text: "Register connector" }), register);

  const mapping = element("section", { className: "panel" }, [
    element("div", { className: "panel-heading" }, [element("h2", { text: "Billed-line mapping" })]),
    element("p", { text: "Refresh Teideal's read-only billed-line map from already-synced connector records." }),
  ]);
  const map = element("button", { type: "button", className: "button", text: "Map billed lines" });
  mapping.append(map);
  container.append(pageHeader("Stripe", "Connect a read-only Stripe account, sync billing records, and map billed lines for Verify."), error, status, connect, health, mapping);

  async function loadHealth() {
    const result = await ctx.apiFetch("/connectors/sync-health");
    const cards = element("div", { className: "card-grid" });
    for (const connector of result.data ?? []) {
      const card = element("article", { className: "connector-card" }, [
        element("div", { className: "panel-heading" }, [element("h3", { text: connector.display_name }), element("span", { className: "section-tag", text: connector.status })]),
        definitionList([["Connector ID", connector.id], ["Type", connector.connector_type], ["Last success", connector.last_success_at], ["Last error", connector.last_error]]),
      ]);
      const actions = element("div", { className: "button-row" });
      actions.append(
        element("button", { type: "button", className: "button secondary", text: "Sync now", onclick: async () => {
          try { await ctx.apiFetch(`/connectors/${connector.id}/sync`, { method: "POST" }); status.textContent = "Connector sync completed."; await loadHealth(); } catch (caught) { setError(error, caught); }
        } }),
        element("button", { type: "button", className: "button danger", text: "Disconnect Verify connector", dataset: { connectorDisconnect: connector.id }, onclick: async () => {
          if (!confirm("Disconnect this read-only Verify connector? The shared Stripe OAuth connection is not revoked.")) return;
          try { await ctx.apiFetch(`/connectors/${connector.id}`, { method: "DELETE" }); status.textContent = "Verify connector disconnected."; await loadHealth(); } catch (caught) { setError(error, caught); }
        } }),
      );
      card.append(actions); cards.append(card);
    }
    health.replaceChildren(element("div", { className: "panel-heading" }, [element("h2", { text: "Sync health" })]), cards);
  }

  authorize.addEventListener("click", async () => {
    try {
      const result = await ctx.apiFetch("/stripe/connect/authorize-url?scope=read_only");
      status.replaceChildren(element("span", { text: result.notice ?? "Continue in Stripe." }), " ", element("a", { href: result.url, text: "Open Stripe authorization", target: "_blank", rel: "noreferrer" }));
    } catch (caught) { setError(error, caught); }
  });
  callback.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { const result = await ctx.apiFetch("/stripe/connect/callback", { method: "POST", body: JSON.stringify({ code: code.value, state: state.value }) }); status.replaceChildren(element("span", { text: "Stripe connected. Connection ID: " }), element("code", { text: result.id })); }
    catch (caught) { setError(error, caught); }
  });
  register.addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await ctx.apiFetch("/connectors/stripe/register", { method: "POST", body: JSON.stringify({ stripe_connection_id: connectionId.value, display_name: displayName.value }) }); status.textContent = "Connector registered."; register.reset(); await loadHealth(); }
    catch (caught) { setError(error, caught); }
  });
  map.addEventListener("click", async () => {
    try { const result = await ctx.apiFetch("/verify/map-billed-lines", { method: "POST" }); status.replaceChildren(element("span", { text: "Billed lines mapped." }), jsonBlock(result)); }
    catch (caught) { setError(error, caught); }
  });
  try { await loadHealth(); } catch (caught) { setError(error, caught); }
}
