/**
 * Pure email formatting utilities for SMTP outbound emails.
 *
 * Converts formatted draft content (bold, italic, underline, strikethrough, links, bullets, numbered lists, quotes)
 * into safe HTML email markup while generating a clean, readable plain-text alternative.
 *
 * All user content is safely escaped to prevent HTML injection / XSS.
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strips formatting markers from draft text to produce clean, readable plain text.
 */
export function formatPlainTextAlternative(rawText: string): string {
  if (!rawText) return "";

  let text = rawText;

  // Convert HTML breaks and block tags to newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");

  // Convert list items to bullet points
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "• $1\n");
  text = text.replace(/<\/?(?:ul|ol)>/gi, "\n");

  // Convert blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");

  // Convert HTML links <a href="url">Label</a> -> Label (url)
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
    const cleanHref = href.trim();
    if (!cleanLabel || cleanLabel === cleanHref) return cleanHref;
    return `${cleanLabel} (${cleanHref})`;
  });

  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Convert markdown links [Label](url) -> Label (url)
  text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s\)"']+)\)/gi, (_m, label, url) => {
    if (label.trim() === url.trim()) return url;
    return `${label} (${url})`;
  });

  // Strip bold markers **text** or __text__ -> text
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");

  // Strip italic markers *text* or _text_ -> text
  text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1");
  text = text.replace(/(?<![a-zA-Z0-9_])_([^_\n]+?)_(?![a-zA-Z0-9_])/g, "$1");

  // Strip strikethrough ~~text~~ -> text
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Unescape standard HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Normalize excess newlines (max 2 consecutive newlines)
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Converts formatted draft text to safe, styled HTML email markup.
 */
export function formatHtmlEmail(rawText: string): string {
  if (!rawText) return "";

  // 1. First escape all raw HTML characters to prevent XSS / markup injection
  let escaped = escapeHtml(rawText);

  // 2. Safely support HTML & markdown bold
  escaped = escaped.replace(/&lt;(?:strong|b)&gt;([\s\S]*?)&lt;\/(?:strong|b)&gt;/gi, "<strong>$1</strong>");
  escaped = escaped.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");

  // 3. Safely support HTML & markdown italic
  escaped = escaped.replace(/&lt;(?:em|i)&gt;([\s\S]*?)&lt;\/(?:em|i)&gt;/gi, "<em>$1</em>");
  escaped = escaped.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
  escaped = escaped.replace(/(?<![a-zA-Z0-9_])_([^_\n]+?)_(?![a-zA-Z0-9_])/g, "<em>$1</em>");

  // 4. Safely support HTML underline (including with attributes like style)
  escaped = escaped.replace(/&lt;u(?:\s[\s\S]*?)?&gt;([\s\S]*?)&lt;\/u&gt;/gi, '<u style="text-decoration: underline;">$1</u>');

  // 5. Safely support HTML & markdown strikethrough
  escaped = escaped.replace(/&lt;(?:s|strike|del)(?:\s[\s\S]*?)?&gt;([\s\S]*?)&lt;\/(?:s|strike|del)&gt;/gi, '<s style="text-decoration: line-through;">$1</s>');
  escaped = escaped.replace(/~~([^~\n]+?)~~/g, '<s style="text-decoration: line-through;">$1</s>');

  // 6. Safely support HTML & markdown links (strictly allow http, https, and mailto)
  escaped = escaped.replace(
    /&lt;a\s+[^&]*?href=(?:&quot;|"|&#39;|')((?:https?:\/\/|mailto:)[^\s"'>&]+)(?:&quot;|"|&#39;|')[\s\S]*?&gt;([\s\S]*?)&lt;\/a&gt;/gi,
    '<a href="$1" style="color: #4f46e5; text-decoration: underline;" target="_blank" rel="noopener noreferrer">$2</a>'
  );
  escaped = escaped.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s\)"']+)\)/gi,
    '<a href="$2" style="color: #4f46e5; text-decoration: underline;" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 7. Safely restore HTML lists
  escaped = escaped.replace(/&lt;li&gt;([\s\S]*?)&lt;\/li&gt;/gi, '<li style="margin-bottom: 0.25em;">$1</li>');
  escaped = escaped.replace(/&lt;ul&gt;([\s\S]*?)&lt;\/ul&gt;/gi, '<ul style="margin: 0.5em 0 1em 1.5em; padding-left: 0.5em; list-style-type: disc;">$1</ul>');
  escaped = escaped.replace(/&lt;ol&gt;([\s\S]*?)&lt;\/ol&gt;/gi, '<ol style="margin: 0.5em 0 1em 1.5em; padding-left: 0.5em; list-style-type: decimal;">$1</ol>');

  // 8. Safely restore HTML blockquotes
  escaped = escaped.replace(
    /&lt;blockquote&gt;([\s\S]*?)&lt;\/blockquote&gt;/gi,
    '<blockquote style="margin: 0.8em 0; padding: 0.4em 0 0.4em 1em; border-left: 3px solid #6366f1; color: #475569; font-style: italic;">$1</blockquote>'
  );

  // 9. Safely restore HTML line breaks and paragraphs
  escaped = escaped.replace(/&lt;br\s*\/?&gt;/gi, "<br />");
  escaped = escaped.replace(/&lt;\/?div&gt;/gi, "");

  if (/&lt;p&gt;/i.test(escaped)) {
    escaped = escaped.replace(/&lt;p&gt;([\s\S]*?)&lt;\/p&gt;/gi, (_m, content) => {
      const trimmed = content.trim();
      if (!trimmed) return "";
      return `<p style="margin: 0 0 1em 0; line-height: 1.6; color: #1e293b;">${trimmed}</p>`;
    });
    escaped = escaped.replace(/&lt;\/?p&gt;/gi, "");
  }

  // 10. Parse markdown-style bulleted and numbered lists (lines starting with •, -, * or 1., 2.)
  const bulletListRegex = /(?:^[•\-*]\s+.+(?:\n|$))+/gm;
  escaped = escaped.replace(bulletListRegex, (match) => {
    const items = match
      .trim()
      .split("\n")
      .map((l) => `<li style="margin-bottom: 0.25em;">${l.trim().replace(/^[•\-*]\s+/, "")}</li>`)
      .join("\n");
    return `\n<ul style="margin: 0.5em 0 1em 1.5em; padding-left: 0.5em; list-style-type: disc;">\n${items}\n</ul>\n`;
  });

  const numberListRegex = /(?:^\d+\.\s+.+(?:\n|$))+/gm;
  escaped = escaped.replace(numberListRegex, (match) => {
    const items = match
      .trim()
      .split("\n")
      .map((l) => `<li style="margin-bottom: 0.25em;">${l.trim().replace(/^\d+\.\s+/, "")}</li>`)
      .join("\n");
    return `\n<ol style="margin: 0.5em 0 1em 1.5em; padding-left: 0.5em; list-style-type: decimal;">\n${items}\n</ol>\n`;
  });

  // 11. Split into blocks/paragraphs by blank lines for remaining markdown / plain text inputs
  const blocks = escaped.split(/\n\s*\n/);

  const formattedBlocks = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";

    // If already wrapped in HTML block element (p, ul, ol, blockquote), return as-is
    if (/^<(?:p|ul|ol|blockquote)\b/i.test(trimmed)) {
      return trimmed;
    }

    // Check if blockquote (starts with &gt; )
    if (trimmed.startsWith("&gt; ")) {
      const quoteText = trimmed.replace(/^&gt;\s*/gm, "").replace(/\n/g, "<br />");
      return `<blockquote style="margin: 0.8em 0; padding: 0.4em 0 0.4em 1em; border-left: 3px solid #6366f1; color: #475569; font-style: italic;">${quoteText}</blockquote>`;
    }

    // Replace single newlines within the paragraph with <br />
    const withBreaks = trimmed.replace(/\n/g, "<br />\n");
    return `<p style="margin: 0 0 1em 0; line-height: 1.6; color: #1e293b;">${withBreaks}</p>`;
  });

  const bodyContent = formattedBlocks.filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1e293b; background-color: #ffffff; margin: 0; padding: 16px;">
${bodyContent}
</body>
</html>`;
}

/**
 * Validates outbound email input. Returns an error message string or null if valid.
 */
export function validateEmailInput(payload: {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
}): string | null {
  if (!payload || typeof payload !== "object") {
    return "Invalid request body.";
  }

  const { to, subject, body } = payload;

  if (!to || typeof to !== "string" || !to.trim()) {
    return "Recipient email (to) is required.";
  }

  // Simple RFC 5322 regex check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(to.trim())) {
    return "A valid recipient email address is required.";
  }

  if (!subject || typeof subject !== "string" || !subject.trim()) {
    return "Email subject is required.";
  }

  if (subject.length > 500) {
    return "Email subject must not exceed 500 characters.";
  }

  if (!body || typeof body !== "string" || !body.trim()) {
    return "Email body is required.";
  }

  return null;
}
