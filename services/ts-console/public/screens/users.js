import { clear, definitionList, element, errorRegion, field, formButton, pageHeader, selectInput, setError, textInput } from "./shared.js";
import { apiKeysPanel } from "./apiKeys.js";

const roles = ["Owner", "Billing Admin", "Finance", "Support", "Developer"];

function usersPanel(ctx) {
  const section = element("section", { className: "panel" });
  const error = errorRegion();
  const list = element("div", { className: "card-grid" });
  const form = element("form", { className: "inline-form" });
  const email = textInput("email", "person@example.com", "email"); email.required = true;
  const password = textInput("password", "Temporary password", "password"); password.required = true;
  const role = selectInput("role", roles, "Developer");
  form.append(field("Email", email), field("Temporary password", password), field("Role", role), formButton("Create user"));
  section.append(element("div", { className: "panel-heading" }, [element("h2", { text: "Users and roles" })]), error, form, list);

  async function load() {
    const result = await ctx.apiFetch("/users");
    list.replaceChildren();
    for (const user of result.data ?? []) {
      const roleSelect = selectInput("role", roles, user.role);
      const card = element("article", { className: "user-card" }, [
        element("h3", { text: user.email }),
        definitionList([["User ID", user.id], ["MFA enrolled", String(user.mfa_enrolled)], ["Created", user.created_at]]),
        element("div", { className: "button-row" }, [
          roleSelect,
          element("button", { type: "button", className: "button secondary", text: "Update role", onclick: async () => {
            try { await ctx.apiFetch(`/users/${user.id}/role`, { method: "PATCH", body: JSON.stringify({ role: roleSelect.value }) }); await load(); }
            catch (caught) { setError(error, caught); }
          } }),
          element("button", { type: "button", className: "button danger", text: "Delete", onclick: async () => {
            try { await ctx.apiFetch(`/users/${user.id}`, { method: "DELETE" }); await load(); }
            catch (caught) { setError(error, caught); }
          } }),
        ]),
      ]);
      list.append(card);
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); error.hidden = true;
    try { await ctx.apiFetch("/users", { method: "POST", body: JSON.stringify({ email: email.value, password: password.value, role: role.value }) }); form.reset(); await load(); }
    catch (caught) { setError(error, caught); }
  });
  load().catch((caught) => setError(error, caught));
  return section;
}

export async function render(container, ctx) {
  clear(container);
  container.append(pageHeader("Access management", "Manage people, roles, and scoped API credentials."));
  if (ctx.principal.role !== "Developer") container.append(usersPanel(ctx));
  container.append(apiKeysPanel(ctx));
}
