export function clear(node) {
  node.replaceChildren();
}

export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value ?? "";
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

export function pageHeader(title, description) {
  return element("div", { className: "page-header" }, [
    element("p", { className: "eyebrow", text: "Teideal operations" }),
    element("h1", { text: title }),
    element("p", { className: "lede", text: description }),
  ]);
}

export function setError(node, error) {
  const message = error instanceof Error ? error.message : String(error);
  node.textContent = message;
  node.hidden = false;
}

export function errorRegion() {
  return element("div", { className: "inline-error", role: "alert", hidden: "" });
}

export function statusRegion() {
  return element("div", { className: "status-message", role: "status", "aria-live": "polite" });
}

export function field(label, input) {
  const id = input.id || `field-${Math.random().toString(36).slice(2)}`;
  input.id = id;
  return element("label", { className: "field", for: id }, [
    element("span", { text: label }),
    input,
  ]);
}

export function button(label, onClick, className = "button") {
  return element("button", { type: "button", className, text: label, onclick: onClick });
}

export function formButton(label, className = "button") {
  return element("button", { type: "submit", className, text: label });
}

export function textInput(name, placeholder = "", type = "text") {
  return element("input", { name, type, placeholder });
}

export function selectInput(name, values, selected) {
  const select = element("select", { name });
  for (const value of values) {
    const option = element("option", { value, text: value });
    if (value === selected) option.selected = true;
    select.append(option);
  }
  return select;
}

export function jsonBlock(value) {
  return element("pre", { className: "json-block", text: JSON.stringify(value, null, 2) });
}

export function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export function definitionList(entries, className = "definition-grid") {
  const list = element("dl", { className });
  for (const [label, value] of entries) {
    list.append(element("div", {}, [
      element("dt", { text: label }),
      element("dd", { text: valueOrDash(value) }),
    ]));
  }
  return list;
}

export function customerPicker(ctx, { allowList = true } = {}) {
  const input = textInput("customer_id", "Customer UUID");
  input.required = true;
  input.autocomplete = "off";
  const wrap = field("Customer", input);
  if (allowList) {
    const listId = `customers-${Math.random().toString(36).slice(2)}`;
    const list = element("datalist", { id: listId });
    input.setAttribute("list", listId);
    wrap.append(list);
    ctx.apiFetch("/customers").then((result) => {
      for (const customer of result.data ?? []) {
        list.append(element("option", { value: customer.id, label: customer.name }));
      }
    }).catch(() => undefined);
  }
  return { wrap, input };
}

export function renderRecords(container, records, emptyText = "No records found.") {
  container.replaceChildren();
  if (!records?.length) {
    container.append(element("p", { className: "empty-state", text: emptyText }));
    return;
  }
  const list = element("div", { className: "record-list" });
  for (const record of records) list.append(jsonBlock(record));
  container.append(list);
}
