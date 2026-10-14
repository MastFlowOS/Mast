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

  it("unwraps transparent background artifact spans from contentEditable without leaking raw HTML", () => {
    const rawWithSpans = `<p><span style="background-color: rgba(0, 0, 0, 0);">Hi Alex,</span></p>
<p><span style="background-color: rgba(0, 0, 0, 0);">I wanted to reach out regarding your website.</span></p>
<p><span style="background-color: transparent;"><span style="background-color: rgba(0, 0, 0, 0);">Best regards,<br>Ibrahim</span></span></p>`;

    const html = formatHtmlEmail(rawWithSpans);

    // Raw HTML tags or escaped tag entities must NOT appear in body text
    assert.ok(!html.includes("background-color: rgba(0, 0, 0, 0);"), "Transparent background style stripped");
    assert.ok(!html.includes("&lt;span"), "No escaped span opening tag in output");
    assert.ok(!html.includes("&lt;/span&gt;"), "No escaped span closing tag in output");
    assert.ok(!html.includes('<span style="background-color'), "No raw transparent span in output");

    // Content is properly formatted
    assert.ok(html.includes("Hi Alex,"), "Greeting present");
    assert.ok(html.includes("I wanted to reach out regarding your website."), "Body text present");
    assert.ok(html.includes("Best regards,<br />Ibrahim"), "Closing present with line break");

    // Plain text alternative is clean
    const plain = formatPlainTextAlternative(rawWithSpans);
    assert.ok(!plain.includes("<span"));
    assert.ok(!plain.includes("rgba("));
    assert.ok(plain.includes("Hi Alex,"));
    assert.ok(plain.includes("Best regards,\nIbrahim"));
  });

  it("retains valid span styles while stripping transparent background artifacts", () => {
    const input = `<p><span style="color: rgb(30, 41, 59); background-color: rgba(0, 0, 0, 0);">Custom colored text</span></p>`;
    const html = formatHtmlEmail(input);

    assert.ok(html.includes('style="color: rgb(30, 41, 59);"'), "Legitimate color style retained");
    assert.ok(!html.includes("rgba(0, 0, 0, 0)"), "Transparent background stripped");
    assert.ok(!html.includes("&lt;span"), "No escaped span markup");
  });

  it("formats numbered (<ol>) and bulleted (<ul>) lists properly in both HTML and plain text", () => {
    const htmlListInput = `<p>Here are 3 reasons to connect:</p>
<ol>
  <li>Faster page loads</li>
  <li>Better mobile conversion</li>
  <li>Improved SEO ranking</li>
</ol>
<p>And key features:</p>
<ul>
  <li>Full audit report</li>
  <li>Implementation support</li>
</ul>`;

    const html = formatHtmlEmail(htmlListInput);

    // HTML lists must have proper email-friendly inline styles
    assert.ok(html.includes('<ol style="margin: 0.5em 0 1em 1.5em; padding-left: 0.5em; list-style-type: decimal;">'));
    assert.ok(html.includes('<li style="margin-bottom: 0.25em;">Faster page loads</li>'));
    assert.ok(html.includes('<ul style="margin: 0.5em 0 1em 1.5em; padding-left: 0.5em; list-style-type: disc;">'));
    assert.ok(html.includes('<li style="margin-bottom: 0.25em;">Full audit report</li>'));

    // Plain-text alternative must render numbers and bullets cleanly
    const plain = formatPlainTextAlternative(htmlListInput);
    assert.ok(plain.includes("1. Faster page loads"));
    assert.ok(plain.includes("2. Better mobile conversion"));
    assert.ok(plain.includes("3. Improved SEO ranking"));
    assert.ok(plain.includes("• Full audit report"));
    assert.ok(plain.includes("• Implementation support"));
    assert.ok(!plain.includes("<ol>"));
    assert.ok(!plain.includes("<ul>"));
    assert.ok(!plain.includes("<li>"));
  });

  it("handles hyperlinks with query parameters, arbitrary attribute order, and safe protocols", () => {
    const linkInput = `<p>Check our <a target="_blank" href="https://example.com/demo?campaign=winter&source=email">winter demo</a> or email us at <a href="mailto:team@example.com">team</a>.</p>`;

    const html = formatHtmlEmail(linkInput);
    assert.ok(html.includes('href="https://example.com/demo?campaign=winter&amp;source=email"'));
    assert.ok(html.includes('style="color: #4f46e5; text-decoration: underline;"'));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(html.includes('href="mailto:team@example.com"'));

    const plain = formatPlainTextAlternative(linkInput);
    assert.ok(plain.includes("winter demo (https://example.com/demo?campaign=winter&source=email)"));
    assert.ok(plain.includes("team (mailto:team@example.com)"));
    assert.ok(!plain.includes("<a"));
  });

  it("renders strikethrough and underline with inline CSS for cross-client compatibility", () => {
    const raw = `<p>Was <s>$99/mo</s>, now <u>$49/mo</u> for early adopters.</p>
<p>Also test ~~discounted~~ pricing.</p>`;

    const html = formatHtmlEmail(raw);
    assert.ok(html.includes('<s style="text-decoration: line-through;">$99/mo</s>'));
    assert.ok(html.includes('<u style="text-decoration: underline;">$49/mo</u>'));
    assert.ok(html.includes('<s style="text-decoration: line-through;">discounted</s>'));

    const plain = formatPlainTextAlternative(raw);
    assert.ok(plain.includes("Was $99/mo, now $49/mo for early adopters."));
    assert.ok(plain.includes("Also test discounted pricing."));
    assert.ok(!plain.includes("<s>"));
    assert.ok(!plain.includes("<u>"));
    assert.ok(!plain.includes("~~"));
  });

  it("prevents literal &nbsp; entity leaks in both HTML and plain-text output", () => {
    const inputWithNbsp = `<p>First&nbsp;sentence.&nbsp;&nbsp;Second&nbsp;sentence.</p>`;

    const html = formatHtmlEmail(inputWithNbsp);
    // Should NOT have &amp;nbsp; which renders literally as "&nbsp;" in Gmail
    assert.ok(!html.includes("&amp;nbsp;"), "Never emit &amp;nbsp; in HTML email");

    const plain = formatPlainTextAlternative(inputWithNbsp);
    assert.ok(!plain.includes("&nbsp;"), "Plain text must convert &nbsp; to normal spaces");
    assert.ok(plain.includes("First sentence."));
  });

  it("preserves paragraph spacing and line breaks accurately", () => {
    const input = `<p>Paragraph 1 line 1<br>Paragraph 1 line 2</p>
<p>Paragraph 2</p>`;

    const html = formatHtmlEmail(input);
    assert.ok(html.includes('<p style="margin: 0 0 1em 0; line-height: 1.6; color: #1e293b;">Paragraph 1 line 1<br />Paragraph 1 line 2</p>'));
    assert.ok(html.includes('<p style="margin: 0 0 1em 0; line-height: 1.6; color: #1e293b;">Paragraph 2</p>'));

    const plain = formatPlainTextAlternative(input);
    assert.ok(plain.includes("Paragraph 1 line 1\nParagraph 1 line 2\n\nParagraph 2"));
  });
});

