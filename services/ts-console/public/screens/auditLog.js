import { clear, element, errorRegion, jsonBlock, pageHeader, setError } from "./shared.js";

export async function render(container, ctx) {
  clear(container);
  const error = errorRegion();
  const content = element("section", { className: "panel" });
  const to = new Date();
  const from = new Date(to); from.setDate(from.getDate() - 30);
  const query = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  const exportLink = element("a", { className: "button secondary", href: `/audit-log/export.csv?${query}`, text: "Export CSV", dataset: { exportEndpoint: "/audit-log/export.csv" } });
  exportLink.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      const blob = await ctx.apiFetch(`/audit-log/export.csv?${query}`, { responseType: "blob" });
      const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "audit-log.csv"; link.click(); URL.revokeObjectURL(link.href);
    } catch (caught) { setError(error, caught); }
  });
  container.append(pageHeader("Audit log", "Review immutable configuration and operational activity from the last 30 days."), element("div", { className: "toolbar end" }, [exportLink]), error, content);
  try {
    const result = await ctx.apiFetch(`/audit-log?${query}`);
    const list = element("div", { className: "audit-list" });
    for (const entry of result.data ?? []) list.append(element("article", { className: "audit-entry" }, [
      element("div", { className: "panel-heading" }, [element("h3", { text: entry.event_type }), element("time", { text: entry.occurred_at })]),
      jsonBlock(entry),
    ]));
    if (!result.data?.length) list.append(element("p", { className: "empty-state", text: "No audit entries in this period." }));
    content.replaceChildren(list);
  } catch (caught) { setError(error, caught); }
}
