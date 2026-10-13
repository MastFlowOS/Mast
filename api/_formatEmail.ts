/**
 * Pure email formatting utilities for SMTP outbound emails.
 *
 * Converts formatted draft content (bold, italic, underline, links, bullets, quotes)
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

  // Strip <u> and </u> tags inserted by the underline toolbar
  text = text.replace(/<\/?u>/gi, "");

  // Convert markdown links [Label](url) -> Label (url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+|mailto:[^\s\)]+)\)/gi, "$1 ($2)");

  // Strip bold markers **text** or __text__ -> text
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");

  return text.trim();
}

/**
 * Converts formatted draft text to safe, styled HTML email markup.
 */
export function formatHtmlEmail(rawText: string): string {
  if (!rawText) return "";

  // 1. First escape all raw HTML characters to prevent XSS / markup injection
  let escaped = escapeHtml(rawText);

  // 2. Safely support <u>...</u> inserted by the editor toolbar
  // In the escaped text, they appear as &lt;u&gt;...&lt;/u&gt;
  escaped = escaped.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/gi, '<u style="text-decoration: underline;">$1</u>');

  // 3. Convert markdown bold **text** and __text__
  escaped = escaped.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");

  // 4. Convert markdown italic *text* and _text_
  escaped = escaped.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
  escaped = escaped.replace(/(?<![a-zA-Z0-9_])_([^_\n]+?)_(?![a-zA-Z0-9_])/g, "<em>$1</em>");

  // 5. Convert markdown links [Label](url) - strictly allow http, https, and mailto
  escaped = escaped.replace(
    /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s\)"']+)\)/gi,
    '<a href="$2" style="color: #4f46e5; text-decoration: underline;" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 6. Split into paragraphs by blank lines
  const paragraphs = escaped.split(/\n\s*\n/);

  const formattedParagraphs = paragraphs.map((para) => {
    const trimmed = para.trim();
    if (!trimmed) return "";

    // Check if paragraph is a blockquote (starts with &gt; )
    if (trimmed.startsWith("&gt; ")) {
      const quoteText = trimmed.replace(/^&gt;\s*/gm, "").replace(/\n/g, "<br />");
      return `<blockquote style="margin: 0.8em 0; padding: 0.4em 0 0.4em 1em; border-left: 3px solid #6366f1; color: #475569; font-style: italic;">${quoteText}</blockquote>`;
    }

    // Replace single newlines within the paragraph with <br />
    const withBreaks = trimmed.replace(/\n/g, "<br />\n");
    return `<p style="margin: 0 0 1em 0; line-height: 1.6; color: #1e293b;">${withBreaks}</p>`;
  });

  const bodyContent = formattedParagraphs.filter(Boolean).join("\n");

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
