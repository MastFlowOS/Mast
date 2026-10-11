import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatHtmlEmail,
  formatPlainTextAlternative,
  validateEmailInput,
} from "../../../api/_formatEmail.js";

describe("Email formatting and input validation", () => {
  it("validates recipient email, subject, and body correctly", () => {
    // Missing/invalid email
    assert.equal(validateEmailInput({ to: "", subject: "Hi", body: "Hello" }), "Recipient email (to) is required.");
    assert.equal(validateEmailInput({ to: "not-an-email", subject: "Hi", body: "Hello" }), "A valid recipient email address is required.");

    // Missing subject
    assert.equal(validateEmailInput({ to: "test@example.com", subject: "", body: "Hello" }), "Email subject is required.");
    assert.equal(validateEmailInput({ to: "test@example.com", subject: "   ", body: "Hello" }), "Email subject is required.");

    // Subject too long
    assert.equal(
      validateEmailInput({ to: "test@example.com", subject: "a".repeat(501), body: "Hello" }),
      "Email subject must not exceed 500 characters."
    );

    // Missing body
    assert.equal(validateEmailInput({ to: "test@example.com", subject: "Hi", body: "" }), "Email body is required.");
    assert.equal(validateEmailInput({ to: "test@example.com", subject: "Hi", body: "   " }), "Email body is required.");

    // Valid input
    assert.equal(validateEmailInput({ to: "lead@example.com", subject: "Quick inquiry", body: "Hello there" }), null);
  });

  it("converts bold, italic, underline, and links into intended email HTML formatting", () => {
    const raw = `Hi John,

We love your **coffee shop** and wanted to share a *quick idea*.
<u>Special offer</u>: check out our [portfolio](https://mast.example.com).

Best,
Sarah`;

    const html = formatHtmlEmail(raw);

    // Formatted tags must be present
    assert.ok(html.includes("<strong>coffee shop</strong>"), "Bold markers converted to strong tags");
    assert.ok(html.includes("<em>quick idea</em>"), "Italic markers converted to em tags");
    assert.ok(html.includes('<u style="text-decoration: underline;">Special offer</u>'), "Underline tags preserved and styled");
    assert.ok(html.includes('<a href="https://mast.example.com"'), "Markdown link converted to anchor tag");
    assert.ok(html.includes(">portfolio</a>"), "Link label preserved");

    // Literal markdown markers should not be leaked in place of formatted tags
    assert.ok(!html.includes("**coffee shop**"));
    assert.ok(!html.includes("[portfolio](https://mast.example.com)"));
  });

  it("safely escapes HTML injection and XSS attempts in email content", () => {
    const malicious = `Hello <script>alert("xss")</script> & <img src=x onerror=alert(1)>!
Check [Malicious](javascript:alert(1)) and [Legit](https://secure.example.com?a=1&b=2)`;

    const html = formatHtmlEmail(malicious);

    // Scripts and raw tags must be escaped
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));

    // javascript: links must NOT be converted to executable anchor tags
    assert.ok(!html.includes('href="javascript:'));

    // Safe links must be converted and entity-safe
    assert.ok(html.includes('href="https://secure.example.com?a=1&amp;b=2"'));
  });

  it("produces a readable, clean plain-text alternative without raw HTML tags", () => {
    const formatted = `Hello Jane,

We have a **huge announcement**!
<u>Underlined note</u> about our [new site](https://example.com).`;

    const plain = formatPlainTextAlternative(formatted);

    // No raw HTML tags
    assert.ok(!plain.includes("<u>"));
    assert.ok(!plain.includes("</u>"));
    assert.ok(plain.includes("Underlined note"));

    // Links formatted cleanly as Label (url)
    assert.ok(plain.includes("new site (https://example.com)"));

    // Bold asterisks stripped
    assert.ok(plain.includes("huge announcement"));
    assert.ok(!plain.includes("**huge announcement**"));
  });
});
