import { clear, element, errorRegion, pageHeader, setError } from "./shared.js";

export async function render(container, ctx) {
  clear(container);
  const canMutate = ctx.principal.role === "Owner" || ctx.principal.role === "Billing Admin";
  const month = element("input", { type: "month", value: ctx.getMonth(), "aria-label": "Close month" });
  const error = errorRegion();
  const content = element("section", { className: "panel" });
  container.append(pageHeader("Period close", "Review customer-period billing summaries before taking any close action."), element("div", { className: "toolbar" }, [element("label", { className: "field compact" }, [element("span", { text: "Month" }), month])]), error, content);

  async function load() {
    error.hidden = true; ctx.setMonth(month.value);
    try {
      const result = await ctx.apiFetch(`/period-close-summary?period=${encodeURIComponent(month.value)}`);
      const periodStart = new Date(`${month.value}-01T00:00:00.000Z`);
      const periodEnd = new Date(periodStart);
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
      const table = element("table", { className: "data-table" });
      table.append(element("thead", {}, [element("tr", {}, ["Customer", "Usage billed", "Commit drawn", "Overage", "Expired credits", "Adjustments", ...(canMutate ? ["Action"] : [])].map((label) => element("th", { scope: "col", text: label })))]));
      const body = element("tbody");
      for (const row of result.data ?? []) {
        const tr = element("tr");
        for (const [name, value] of [["customer_name", row.customer_name], ["usage_billed", row.usage_billed], ["commit_drawn_down", row.commit_drawn_down], ["overage", row.overage], ["expired_credits", row.expired_credits], ["adjustments", row.adjustments]]) {
          tr.append(element("td", { text: value, dataset: name === "customer_name" ? {} : { moneyField: name, customerId: row.customer_id } }));
        }
        if (canMutate) tr.append(element("td", {}, [element("button", { type: "button", className: "button secondary small", text: "Sync period to Stripe", onclick: async () => {
          try { await ctx.apiFetch(`/period-close/${row.customer_id}/stripe-sync`, { method: "POST", body: JSON.stringify({ period_start: periodStart.toISOString(), period_end: periodEnd.toISOString() }) }); }
          catch (caught) { setError(error, caught); }
        } })]));
        body.append(tr);
      }
      table.append(body);
      content.replaceChildren(element("div", { className: "panel-heading" }, [element("h2", { text: `Summary · ${month.value}` })]), table);
    } catch (caught) { setError(error, caught); content.replaceChildren(); }
  }
  month.addEventListener("change", load);
  await load();
}
