import { clear, customerPicker, definitionList, element, errorRegion, jsonBlock, pageHeader, setError } from "./shared.js";

function timelineEntry(entry) {
  return element("article", { className: "timeline-entry" }, [
    element("div", { className: "timeline-marker" }),
    element("div", {}, [
      element("div", { className: "timeline-title" }, [element("strong", { text: entry.type }), element("time", { text: entry.occurred_at })]),
      jsonBlock(entry),
    ]),
  ]);
}

export async function render(container, ctx) {
  clear(container);
  const privileged = ctx.principal.role === "Owner" || ctx.principal.role === "Billing Admin";
  const picker = customerPicker(ctx, { allowList: privileged });
  const load = element("button", { type: "submit", className: "button", text: "Load customer" });
  const form = element("form", { className: "toolbar customer-toolbar" }, [picker.wrap, load]);
  const error = errorRegion();
  const detail = element("section", { className: "customer-overview" });
  const timeline = element("section", { className: "panel" }, [element("div", { className: "panel-heading" }, [element("h2", { text: "Timeline" })])]);
  const timelineBody = element("div", { className: "timeline" });
  timeline.append(timelineBody);
  container.append(pageHeader("Customer", "Inspect customer activity in one chronological trail."), form, error);
  if (privileged) container.append(detail);
  container.append(timeline);

  form.addEventListener("submit", async (event) => {
    event.preventDefault(); error.hidden = true; load.disabled = true;
    const id = picker.input.value.trim();
    timelineBody.replaceChildren(element("p", { className: "empty-state", text: "Loading timeline…" }));
    try {
      if (privileged) {
        const [customer, subscriptionResult, grantsResult] = await Promise.all([
          ctx.apiFetch(`/customers/${encodeURIComponent(id)}`),
          ctx.apiFetch(`/customers/${encodeURIComponent(id)}/subscription`).catch((caught) => caught.status === 404 ? null : Promise.reject(caught)),
          ctx.apiFetch(`/grants?customer_id=${encodeURIComponent(id)}`),
        ]);
        const grants = (grantsResult.data ?? []).filter((grant) => grant.customer_id === id);
        const planPanel = element("section", { className: "panel", dataset: { section: "plan-balance" } }, [
          element("div", { className: "panel-heading" }, [element("h2", { text: customer.name }), element("span", { text: customer.email })]),
          element("h3", { text: "Plan" }),
          subscriptionResult ? definitionList([
            ["Current plan", subscriptionResult.current_plan_id],
            ["Plan family", subscriptionResult.plan_family_id],
            ["Grandfathered", String(subscriptionResult.grandfathered)],
            ["Scheduled plan", subscriptionResult.scheduled_plan_id],
          ]) : element("p", { className: "empty-state", text: "No current subscription." }),
          element("h3", { text: "Balance" }),
        ]);
        if (!grants.length) planPanel.append(element("p", { className: "empty-state", text: "No grants available." }));
        else {
          const balances = element("div", { className: "balance-list" });
          for (const grant of grants) balances.append(definitionList([
            ["Source", grant.source], ["Remaining", grant.remaining_amount], ["Unit", grant.unit], ["Status", grant.status],
          ], "definition-grid balance-card"));
          planPanel.append(balances);
        }
        detail.replaceChildren(planPanel);
      }

      const response = await ctx.apiFetch(`/customers/${encodeURIComponent(id)}/timeline`);
      timelineBody.replaceChildren();
      if (!response.entries?.length) timelineBody.append(element("p", { className: "empty-state", text: "No timeline activity." }));
      else for (const entry of response.entries) timelineBody.append(timelineEntry(entry));
    } catch (caught) {
      setError(error, caught); detail.replaceChildren(); timelineBody.replaceChildren();
    } finally { load.disabled = false; }
  });
}
