import { clear, customerPicker, definitionList, element, errorRegion, field, formButton, pageHeader, selectInput, setError, statusRegion, textInput } from "./shared.js";

function grantCard(grant, refresh, ctx, error, status) {
  const card = element("article", { className: `grant-card ${grant.source === "commit" ? "commit-card" : ""}` }, [
    element("div", { className: "panel-heading" }, [element("h3", { text: `${grant.source} · ${grant.unit}` }), element("span", { className: "section-tag", text: grant.status })]),
    definitionList([
      ["Grant ID", grant.id], ["Amount", grant.amount], ["Remaining", grant.remaining_amount],
      ["Starts", grant.start_date], ["Expires", grant.expiry_date],
    ]),
  ]);
  const actions = element("div", { className: "button-row" });
  const action = async (path, method, body) => {
    error.hidden = true;
    try {
      await ctx.apiFetch(path, { method, body: JSON.stringify(body) });
      status.textContent = "Contract updated.";
      await refresh();
    } catch (caught) { setError(error, caught); }
  };
  actions.append(
    element("button", { type: "button", className: "button secondary", text: "Consume", onclick: () => {
      const amount = prompt("Amount to consume");
      if (amount) action(`/grants/${grant.id}/consume`, "POST", { amount: JSON.parse(amount) });
    } }),
    element("button", { type: "button", className: "button danger", text: "Void", onclick: () => {
      const reason = prompt("Reason for voiding");
      if (reason) action(`/grants/${grant.id}/void`, "POST", { reason });
    } }),
  );
  if (grant.source === "commit") actions.append(element("button", { type: "button", className: "button secondary", text: "Amend commit", onclick: () => {
    const reason = prompt("Reason for amendment");
    const overage = prompt("New overage rate");
    if (reason && overage !== null) action(`/grants/${grant.id}/amend`, "PATCH", { reason, overage_rate: JSON.parse(overage) });
  } }));
  card.append(actions);
  return card;
}

export async function render(container, ctx) {
  clear(container);
  const picker = customerPicker(ctx);
  const error = errorRegion();
  const status = statusRegion();
  const subscription = element("section", { className: "panel" });
  const grants = element("section", { className: "panel" });
  const loadForm = element("form", { className: "toolbar" }, [picker.wrap, formButton("Load contract")]);
  container.append(pageHeader("Contract", "Manage plan assignments, grants, and committed balance for a customer."), loadForm, error, status, subscription, grants);

  async function refresh() {
    const id = picker.input.value.trim();
    const [sub, listed, plans] = await Promise.all([
      ctx.apiFetch(`/customers/${encodeURIComponent(id)}/subscription`).catch((caught) => caught.status === 404 ? null : Promise.reject(caught)),
      ctx.apiFetch(`/grants?customer_id=${encodeURIComponent(id)}`),
      ctx.apiFetch("/plans"),
    ]);
    const planOptions = plans.data ?? [];
    const planSelect = element("select", { name: "plan_id", required: "" });
    planSelect.append(element("option", { value: "", text: "Select a published plan" }));
    for (const plan of planOptions) planSelect.append(element("option", { value: plan.id, text: `${plan.name} · v${plan.version ?? "draft"}` }));
    const assign = element("form", { className: "inline-form" }, [field("Plan", planSelect), formButton(sub ? "Replace plan" : "Assign plan")]);
    assign.addEventListener("submit", async (event) => {
      event.preventDefault(); error.hidden = true;
      try {
        await ctx.apiFetch(`/customers/${encodeURIComponent(id)}/subscription`, { method: "POST", body: JSON.stringify({ plan_id: planSelect.value }) });
        status.textContent = "Plan assigned."; await refresh();
      } catch (caught) { setError(error, caught); }
    });
    const subscriptionBody = sub ? definitionList([
      ["Current plan", sub.current_plan_id], ["Plan family", sub.plan_family_id], ["Grandfathered", String(sub.grandfathered)],
      ["Scheduled plan", sub.scheduled_plan_id], ["Migration date", sub.scheduled_migration_date],
    ]) : element("p", { className: "empty-state", text: "No subscription assigned." });
    const migration = element("form", { className: "inline-form" }, [
      field("Target version", element("input", { name: "target_version", type: "number", min: "1", required: "" })),
      formButton("Schedule next boundary", "button secondary"),
    ]);
    migration.addEventListener("submit", async (event) => {
      event.preventDefault(); const data = new FormData(migration);
      try {
        await ctx.apiFetch(`/customers/${encodeURIComponent(id)}/subscription/schedule-migration`, { method: "POST", body: JSON.stringify({ target_version: migration.elements.target_version.valueAsNumber, use_next_period_boundary: true }) });
        status.textContent = "Migration scheduled."; await refresh();
      } catch (caught) { setError(error, caught); }
    });
    const grandfather = element("button", { type: "button", className: "button secondary", text: sub?.grandfathered ? "Remove grandfathering" : "Grandfather", onclick: async () => {
      try {
        await ctx.apiFetch(`/customers/${encodeURIComponent(id)}/subscription/grandfather`, { method: "POST", body: JSON.stringify({ grandfathered: !sub?.grandfathered }) });
        status.textContent = "Grandfathering updated."; await refresh();
      } catch (caught) { setError(error, caught); }
    } });
    subscription.replaceChildren(element("div", { className: "panel-heading" }, [element("h2", { text: "Plan" })]), subscriptionBody, assign);
    if (sub) subscription.append(migration, grandfather);

    const list = (listed.data ?? []).filter((grant) => grant.customer_id === id);
    const create = element("form", { className: "grant-form" });
    const amount = element("input", { name: "amount", type: "number", min: "0.000001", step: "any", required: "" });
    const unit = textInput("unit", "credits"); unit.required = true;
    const source = selectInput("source", ["paid", "promotional", "commit", "goodwill"], "paid");
    const starts = element("input", { name: "start_date", type: "datetime-local", required: "" });
    const expires = element("input", { name: "expiry_date", type: "datetime-local" });
    const drawdown = selectInput("drawdown_schedule", ["upfront", "monthly", "quarterly"], "upfront");
    const overage = element("input", { name: "overage_rate", type: "number", min: "0", step: "any" });
    const carries = element("input", { name: "carries_over", type: "checkbox" });
    create.append(field("Amount", amount), field("Unit", unit), field("Source", source), field("Starts", starts), field("Expires", expires), field("Drawdown", drawdown), field("Overage rate", overage), field("Carries over", carries), formButton("Create grant"));
    create.addEventListener("submit", async (event) => {
      event.preventDefault(); error.hidden = true;
      const body = {
        customer_id: id,
        amount: amount.valueAsNumber,
        unit: unit.value,
        source: source.value,
        start_date: new Date(starts.value).toISOString(),
      };
      if (expires.value) body.expiry_date = new Date(expires.value).toISOString();
      if (source.value === "commit") {
        body.drawdown_schedule = drawdown.value;
        body.overage_rate = overage.valueAsNumber;
        body.carries_over = carries.checked;
      }
      try {
        await ctx.apiFetch("/grants", { method: "POST", body: JSON.stringify(body) });
        status.textContent = "Grant created."; create.reset(); await refresh();
      } catch (caught) { setError(error, caught); }
    });
    const cards = element("div", { className: "card-grid" });
    for (const grant of list) cards.append(grantCard(grant, refresh, ctx, error, status));
    grants.replaceChildren(element("div", { className: "panel-heading" }, [element("h2", { text: "Grants and commits" }), element("span", { text: `${list.length} records` })]), create, cards);
  }

  loadForm.addEventListener("submit", async (event) => {
    event.preventDefault(); error.hidden = true;
    try { await refresh(); } catch (caught) { setError(error, caught); subscription.replaceChildren(); grants.replaceChildren(); }
  });
}
