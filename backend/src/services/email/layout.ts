/**
 * Templates declare content as blocks rather than writing HTML. One renderer
 * then produces both the HTML and the plaintext alternative, so every email in
 * the portal is styled identically and no template can ship HTML-only.
 */
export type EmailBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "facts"; rows: Array<{ label: string; value: string }> }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "callout"; tone: "info" | "success" | "warning" | "danger"; text: string }
  | { kind: "button"; label: string; url: string }
  // A short secret the reader has to retype. Set apart and widely tracked so it
  // survives being read off a phone and cannot be confused with body copy.
  | { kind: "code"; value: string }
  | { kind: "note"; text: string };

export type EmailContent = {
  subject: string;
  // Shown after the subject in most inbox previews. Without it clients fall
  // back to the first words of the layout markup.
  preheader?: string;
  heading: string;
  heroImage?: { url: string; alt: string };
  blocks: EmailBlock[];
};

const palette = {
  ink: "#0f172a",
  muted: "#64748b",
  border: "#cbd5e1",
  surface: "#f8fafc",
  page: "#eef2f7"
};

const calloutTones = {
  info: { border: "#0f172a", background: "#f1f5f9", text: "#0f172a" },
  success: { border: "#15803d", background: "#f0fdf4", text: "#14532d" },
  warning: { border: "#b45309", background: "#fffbeb", text: "#78350f" },
  danger: { border: "#b91c1c", background: "#fef2f2", text: "#7f1d1d" }
} as const;

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBlockHtml(block: EmailBlock): string {
  if (block.kind === "paragraph") {
    return `<p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${palette.ink};">${escapeHtml(block.text)}</p>`;
  }

  if (block.kind === "note") {
    return `<p style="margin:0 0 16px;font-size:12px;line-height:19px;color:${palette.muted};">${escapeHtml(block.text)}</p>`;
  }

  if (block.kind === "facts") {
    const rows = block.rows.map((row) => `
      <tr>
        <td style="padding:7px 0;font-size:12px;color:${palette.muted};width:42%;vertical-align:top;">${escapeHtml(row.label)}</td>
        <td style="padding:7px 0;font-size:13px;color:${palette.ink};font-weight:600;vertical-align:top;">${escapeHtml(row.value)}</td>
      </tr>`).join("");

    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;background:${palette.surface};border:1px solid ${palette.border};border-radius:6px;">
      <tr><td style="padding:6px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table></td></tr>
    </table>`;
  }

  if (block.kind === "table") {
    const head = block.columns
      .map((column) => `<th align="left" style="padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:${palette.muted};border-bottom:1px solid ${palette.border};">${escapeHtml(column)}</th>`)
      .join("");
    const body = block.rows
      .map((row) => `<tr>${row.map((cell) => `<td style="padding:8px 10px;font-size:13px;color:${palette.ink};border-bottom:1px solid #e2e8f0;">${escapeHtml(cell)}</td>`).join("")}</tr>`)
      .join("");

    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;border:1px solid ${palette.border};border-radius:6px;">
      <thead><tr>${head}</tr></thead><tbody>${body}</tbody>
    </table>`;
  }

  if (block.kind === "code") {
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;">
      <tr><td align="center" style="padding:18px 12px;background:${palette.surface};border:1px solid ${palette.border};border-radius:8px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:30px;line-height:36px;font-weight:700;letter-spacing:8px;color:${palette.ink};">${escapeHtml(block.value)}</td></tr>
    </table>`;
  }

  if (block.kind === "callout") {
    const tone = calloutTones[block.tone];
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border-collapse:collapse;">
      <tr><td style="padding:12px 14px;background:${tone.background};border-left:3px solid ${tone.border};border-radius:4px;font-size:13px;line-height:20px;color:${tone.text};">${escapeHtml(block.text)}</td></tr>
    </table>`;
  }

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
    <tr><td style="border-radius:6px;background:${palette.ink};">
      <a href="${escapeHtml(block.url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(block.label)}</a>
    </td></tr>
  </table>`;
}

function renderBlockText(block: EmailBlock): string {
  if (block.kind === "paragraph" || block.kind === "note") return block.text;
  if (block.kind === "callout") return block.text;
  if (block.kind === "code") return block.value;
  if (block.kind === "button") return `${block.label}: ${block.url}`;
  if (block.kind === "facts") return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");

  return [
    block.columns.join(" | "),
    ...block.rows.map((row) => row.join(" | "))
  ].join("\n");
}

export function renderEmail(content: EmailContent, footerNote: string) {
  const preheader = content.preheader ?? "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${palette.page};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${palette.page};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;background:#ffffff;border:1px solid ${palette.border};border-radius:10px;overflow:hidden;">
      <tr><td style="padding:18px 28px;background:${palette.ink};">
        <span style="font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.3px;">Swiftline</span>
        <span style="font-size:12px;color:#94a3b8;margin-left:8px;">Portal</span>
      </td></tr>
      <tr><td style="padding:28px;">
        ${content.heroImage ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;border-collapse:collapse;background:#f0f7f5;border-radius:10px;"><tr><td align="center" style="padding:16px 12px;"><img src="${escapeHtml(content.heroImage.url)}" alt="${escapeHtml(content.heroImage.alt)}" width="180" style="display:block;width:180px;max-width:100%;height:auto;border:0;"></td></tr></table>` : ""}
        <h1 style="margin:0 0 18px;font-size:19px;line-height:26px;color:${palette.ink};font-weight:700;">${escapeHtml(content.heading)}</h1>
        ${content.blocks.map(renderBlockHtml).join("\n")}
      </td></tr>
      <tr><td style="padding:16px 28px;background:${palette.surface};border-top:1px solid ${palette.border};">
        <p style="margin:0;font-size:11px;line-height:17px;color:${palette.muted};">${escapeHtml(footerNote)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    content.heading,
    "",
    ...content.blocks.map(renderBlockText),
    "",
    "-",
    footerNote
  ].join("\n\n").replace(/\n{3,}/g, "\n\n");

  return { html, text };
}
