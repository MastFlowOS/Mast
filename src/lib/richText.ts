/**
 * Rich-text utilities for the Outreach Workspace message composer.
 *
 * Provides bidirectional conversion between structured HTML (used by the
 * rich-text contentEditable editor) and clean plain text (used for clipboard,
 * character counting, fallback display, and plaintext email alternatives).
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
 * Converts formatted HTML to clean, human-readable plain text without HTML tags.
 * Preserves paragraphs, line breaks, list bullet markers, and link URLs in readable format.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";

  // If plain text with no HTML tags, return directly
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    return html.trim();
  }

  let text = html;

  // Convert line breaks and paragraph closing tags
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");

  // Convert list items to bullet points
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "• $1\n");
  text = text.replace(/<\/?(?:ul|ol)>/gi, "\n");

  // Convert blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "\n> $1\n");

  // Convert links <a href="url">Label</a> -> Label (url)
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
    const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
    const cleanHref = href.trim();
    if (!cleanLabel || cleanLabel === cleanHref) return cleanHref;
    return `${cleanLabel} (${cleanHref})`;
  });

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Convert markdown links [Label](url) -> Label (url)
  text = text.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s\)"']+)\)/gi, (_match, label, url) => {
    if (label.trim() === url.trim()) return url;
    return `${label} (${url})`;
  });

  // Strip bold/italic/strikethrough markers if present
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1");
  text = text.replace(/(?<![a-zA-Z0-9_])_([^_\n]+?)_(?![a-zA-Z0-9_])/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Unescape standard HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse 3+ newlines to 2, trim leading/trailing
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatInlineMarkdown(str: string): string {
  return str
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/<u>([\s\S]*?)<\/u>/gi, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s\)"']+)\)/gi,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/**
 * Converts raw text or markdown (e.g. from AI drafts or initial templates) into clean HTML
 * paragraphs and list structures for the rich-text editor.
 * If the input is already HTML, returns it intact.
 */
export function plainTextToHtml(text: string): string {
  if (!text) return "";

  // If text already has HTML block elements or formatting tags, return it
  if (/<(?:p|div|ul|ol|blockquote|strong|b|em|i|u|s|a)\b[^>]*>/i.test(text)) {
    return text;
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const paragraphs: string[] = [];
  let currentList: { type: "ul" | "ol"; items: string[] } | null = null;
  let currentPara: string[] = [];

  const flushPara = () => {
    if (currentPara.length > 0) {
      const content = currentPara.join("<br />");
      if (content.trim()) {
        paragraphs.push(`<p>${formatInlineMarkdown(content)}</p>`);
      }
      currentPara = [];
    }
  };

  const flushList = () => {
    if (currentList) {
      const itemsHtml = currentList.items
        .map((item) => `<li>${formatInlineMarkdown(item)}</li>`)
        .join("");
      paragraphs.push(`<${currentList.type}>${itemsHtml}</${currentList.type}>`);
      currentList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const bulletMatch = line.match(/^[•\-*]\s+(.*)$/);
    const numberMatch = line.match(/^(\d+)\.\s+(.*)$/);
    const quoteMatch = line.match(/^>\s*(.*)$/);

    if (bulletMatch) {
      flushPara();
      if (!currentList || currentList.type !== "ul") {
        flushList();
        currentList = { type: "ul", items: [] };
      }
      currentList.items.push(bulletMatch[1]);
    } else if (numberMatch) {
      flushPara();
      if (!currentList || currentList.type !== "ol") {
        flushList();
        currentList = { type: "ol", items: [] };
      }
      currentList.items.push(numberMatch[2]);
    } else if (quoteMatch) {
      flushPara();
      flushList();
      paragraphs.push(`<blockquote>${formatInlineMarkdown(quoteMatch[1])}</blockquote>`);
    } else if (!line) {
      flushPara();
      flushList();
    } else {
      flushList();
      currentPara.push(line);
    }
  }

  flushPara();
  flushList();

  return paragraphs.join("");
}

/**
 * Normalizes user-entered URLs by ensuring an http/https or mailto scheme.
 * Prevents unsafe javascript:, data:, or vbscript: URLs.
 */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) return "";
  return `https://${trimmed}`;
}

/**
 * Accurately counts words from HTML or plain text by stripping markup and splitting by whitespace.
 */
export function countWords(content: string): number {
  const plain = htmlToPlainText(content).trim();
  if (!plain) return 0;
  return plain.split(/\s+/).filter(Boolean).length;
}
