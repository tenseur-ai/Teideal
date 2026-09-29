function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function renderMarkdown(markdown: string): string {
  const body: string[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  let paragraph: string[] = [];
  let listOpen = false;

  const flushParagraph = () => {
    if (paragraph.length) body.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listOpen) body.push("</ul>");
    listOpen = false;
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^```([A-Za-z0-9_-]+)(?:\s+runnable)?\s*$/);
    if (fence) {
      flushParagraph();
      closeList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== "```") code.push(lines[index++]);
      body.push(`<pre tabindex="0"><code class="language-${escapeHtml(fence[1])}">${escapeHtml(code.join("\n"))}</code></pre>`);
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      body.push(`<h${level} id="${slug(heading[2])}">${inline(heading[2])}</h${level}>`);
    } else if (line.startsWith("- ")) {
      flushParagraph();
      if (!listOpen) {
        body.push("<ul>");
        listOpen = true;
      }
      body.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      flushParagraph();
      closeList();
    } else if (listOpen && /^\s+\S/.test(line)) {
      // An indented continuation of the current list item (standard
      // Markdown line-wrapping) -- append into the just-pushed <li> rather
      // than starting a stray paragraph, which would otherwise land as a
      // <p> direct child of <ul> and fail axe's "list" rule.
      const last = body[body.length - 1];
      body[body.length - 1] = last.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      paragraph.push(line.trim());
    }
    index += 1;
  }
  flushParagraph();
  closeList();

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Teideal quick-start</title><style>body{background:#fff;color:#111;font:16px/1.5 system-ui,sans-serif;max-width:72rem;margin:auto;padding:2rem}a{color:#0645ad}pre{overflow:auto;border:1px solid #767676;padding:1rem}code{font-family:ui-monospace,monospace}</style></head><body><main>${body.join("\n")}</main></body></html>`;
}
