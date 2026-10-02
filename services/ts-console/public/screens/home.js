import { clear, element, errorRegion, pageHeader, setError } from "./shared.js";

function moneyCard(label, value, fieldName) {
  return element("div", { className: "metric-card" }, [
    element("span", { text: label }),
    element("strong", { text: value, dataset: { moneyField: fieldName } }),
  ]);
}

export async function render(container, ctx) {
  clear(container);
  const error = errorRegion();
  const month = element("input", { type: "month", value: ctx.getMonth(), "aria-label": "Report month" });
  const metrics = element("section", { className: "metric-grid", "aria-label": "Report totals" });
  const rows = element("section", { className: "panel" });
  const controls = element("div", { className: "toolbar" }, [
    element("label", { className: "field compact" }, [element("span", { text: "Month" }), month]),
  ]);
  container.append(
    pageHeader("Revenue verification", "Review expected and billed totals, then investigate discrepancies before close."),
    controls,
    error,
    metrics,
    rows,
  );

  async function load() {
    error.hidden = true;
    ctx.setMonth(month.value);
    try {
      const report = await ctx.apiFetch(`/verify/discrepancy-report?period=${encodeURIComponent(month.value)}`);
      metrics.replaceChildren(
        moneyCard("Expected", report.totals.expected, "expected"),
        moneyCard("Billed", report.totals.billed, "billed"),
        moneyCard("Delta", report.totals.delta, "delta"),
        moneyCard("Excluded billed", report.totals.excluded_billed, "excluded_billed"),
      );
      const heading = element("div", { className: "panel-heading" }, [
        element("h2", { text: "Customers" }),
        element("button", { className: "link-button", type: "button", text: "Open full report", onclick: () => ctx.navigate("report") }),
      ]);
      const table = element("table", { className: "data-table" });
      table.append(element("thead", {}, [element("tr", {}, ["Customer", "Expected", "Billed", "Delta", "Status"].map((label) => element("th", { text: label, scope: "col" })))]));
      const body = element("tbody");
      const sorted = [...report.data].sort((left, right) => {
        const leftZero = left.delta === "0.00";
        const rightZero = right.delta === "0.00";
        return leftZero === rightZero ? 0 : leftZero ? 1 : -1;
      });
      for (const row of sorted) {
        const tr = element("tr", { className: row.delta === "0.00" ? "match-row" : "discrepancy-row" });
        tr.append(
          element("td", { text: row.customer_name }),
          element("td", { text: row.expected_total, dataset: { moneyField: "expected_total", customerId: row.customer_id } }),
          element("td", { text: row.billed_total, dataset: { moneyField: "billed_total", customerId: row.customer_id } }),
          element("td", { text: row.delta, dataset: { moneyField: "delta", customerId: row.customer_id } }),
          element("td", { text: row.classification ?? "Match" }),
        );
        body.append(tr);
      }
      table.append(body);
      rows.replaceChildren(heading, table);
    } catch (caught) { setError(error, caught); metrics.replaceChildren(); rows.replaceChildren(); }
  }

  month.addEventListener("change", load);
  await load();
}
