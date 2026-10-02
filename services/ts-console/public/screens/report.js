import { clear, definitionList, element, errorRegion, pageHeader, setError, valueOrDash } from "./shared.js";

function ids(title, values) {
  return element("div", { className: "evidence-group" }, [
    element("h4", { text: title }),
    values?.length ? element("ul", {}, values.map((value) => element("li", {}, [element("code", { text: value })]))) : element("p", { text: "None" }),
  ]);
}

function evidence(row) {
  const billed = element("div", { className: "evidence-group" }, [element("h4", { text: "Billed Stripe lines" })]);
  if (!row.evidence.billed.lines.length) billed.append(element("p", { text: "None" }));
  for (const line of row.evidence.billed.lines) {
    billed.append(element("article", { className: "evidence-line" }, [
      definitionList([
        ["Stripe line ID", line.stripe_invoice_line_id],
        ["Period start", line.period_start?.slice(0, 10)],
        ["Period end", line.period_end?.slice(0, 10)],
        ["Amount", line.amount],
        ["Quantity", line.quantity],
      ], "definition-grid compact-grid"),
    ]));
  }
  return element("div", { className: "evidence-grid" }, [
    billed,
    ids("Ledger line IDs", row.evidence.expected.ledger_line_ids),
    ids("Usage event IDs", row.evidence.expected.usage_event_ids),
    ids("Overage consumption IDs", row.evidence.expected.overage_consumption_line_ids),
  ]);
}

function mappedTable(report) {
  const table = element("table", { className: "data-table report-table" });
  table.append(element("thead", {}, [element("tr", {}, ["Customer", "Expected total", "Billed total", "Delta", "Classification"].map((label) => element("th", { scope: "col", text: label })))]));
  const body = element("tbody");
  for (const row of report.data) {
    const tr = element("tr", {
      className: row.delta === "0.00" ? "match-row interactive-row" : "discrepancy-row interactive-row",
      tabindex: "0",
      role: "button",
      "aria-expanded": "false",
    });
    tr.append(
      element("td", { text: row.customer_name }),
      element("td", { text: row.expected_total, dataset: { moneyField: "expected_total", customerId: row.customer_id } }),
      element("td", { text: row.billed_total, dataset: { moneyField: "billed_total", customerId: row.customer_id } }),
      element("td", { text: row.delta, dataset: { moneyField: "delta", customerId: row.customer_id } }),
      element("td", { text: row.classification ?? "Match" }),
    );
    const detailRow = element("tr", { className: "evidence-row", hidden: "", dataset: { customerId: row.customer_id } });
    detailRow.append(element("td", { colspan: "5" }, [evidence(row)]));
    const toggle = () => {
      const opening = detailRow.hidden;
      detailRow.hidden = !opening;
      tr.setAttribute("aria-expanded", String(opening));
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } });
    body.append(tr, detailRow);
  }
  table.append(body);
  return table;
}

function excludedSection(report) {
  const section = element("section", { className: "panel excluded-section", dataset: { reportSection: "excluded" } }, [
    element("div", { className: "panel-heading" }, [element("h2", { text: "Excluded and caveats" }), element("span", { className: "section-tag", text: "Not included in mapped totals" })]),
  ]);
  section.append(element("div", { className: "excluded-total" }, [
    element("span", { text: "Excluded billed total" }),
    element("strong", { text: report.totals.excluded_billed, dataset: { moneyField: "excluded_billed" } }),
  ]));
  const excluded = element("div", { className: "excluded-list" });
  if (!report.excluded.length) excluded.append(element("p", { className: "empty-state", text: "No excluded customers." }));
  for (const row of report.excluded) {
    excluded.append(element("article", { className: "excluded-card" }, [
      element("h3", { text: row.customer_name ?? row.customer_id }),
      definitionList([["Reason", row.reason], ["Billed total", row.billed_total], ["Stripe customer", row.customer_id]]),
      ids("Stripe line IDs", row.evidence.stripe_invoice_line_ids),
    ]));
  }
  const caveats = element("div", { className: "caveats" }, [element("h3", { text: "Caveats" })]);
  caveats.append(element("ul", {}, report.caveats.map((item) => element("li", { text: item }))));
  section.append(excluded, caveats);
  return section;
}

export async function render(container, ctx) {
  clear(container);
  const error = errorRegion();
  const month = element("input", { type: "month", value: ctx.getMonth(), "aria-label": "Report month" });
  const mapped = element("section", { className: "panel", dataset: { reportSection: "mapped" } });
  const separated = element("div");
  container.append(
    pageHeader("Discrepancy report", "Compare the authoritative expected ledger with the latest mapped Stripe billing data."),
    element("div", { className: "toolbar" }, [element("label", { className: "field compact" }, [element("span", { text: "Month" }), month])]),
    error,
    mapped,
    separated,
  );

  async function load() {
    error.hidden = true; ctx.setMonth(month.value);
    try {
      const report = await ctx.apiFetch(`/verify/discrepancy-report?period=${encodeURIComponent(month.value)}`);
      const totals = element("div", { className: "totals-strip" }, Object.entries(report.totals).filter(([label]) => label !== "excluded_billed").map(([label, value]) =>
        element("div", {}, [element("span", { text: label.replaceAll("_", " ") }), element("strong", { text: value, dataset: { moneyField: label } })]),
      ));
      mapped.replaceChildren(
        element("div", { className: "panel-heading" }, [element("h2", { text: "Mapped customers" }), element("span", { text: `${report.data.length} rows` })]),
        totals,
        mappedTable(report),
      );
      separated.replaceChildren(excludedSection(report));
    } catch (caught) { setError(error, caught); mapped.replaceChildren(); separated.replaceChildren(); }
  }
  month.addEventListener("change", load);
  await load();
}
