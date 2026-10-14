import { useState, useRef, useEffect, useCallback } from "react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Link as LinkIcon,
  Undo2,
  Redo2,
  Wand2,
  Plus,
  Minus,
  Check,
  Trash2,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  htmlToPlainText,
  plainTextToHtml,
  normalizeUrl,
  countWords,
  escapeHtml,
} from "@/lib/richText";

export interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onRewrite?: (type: "rewrite" | "expand" | "shorten") => Promise<void>;
  isGenerating?: boolean;
  className?: string;
}

interface FormattingState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  bullet: boolean;
  number: boolean;
  quote: boolean;
  link: boolean;
}

const defaultFormatting: FormattingState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bullet: false,
  number: false,
  quote: false,
  link: false,
};

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Hi there, write your message or generate one with the AI Assistant...",
  onRewrite,
  isGenerating = false,
  className,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastValueRef = useRef<string>("");
  const isInternalChangeRef = useRef<boolean>(false);
  const savedRangeRef = useRef<Range | null>(null);

  const [formatting, setFormatting] = useState<FormattingState>(defaultFormatting);

  // Link dialog state
  const [isLinkOpen, setIsLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const [isEditingExistingLink, setIsEditingExistingLink] = useState(false);

  // Check if content is visually empty
  const isVisuallyEmpty = !value || htmlToPlainText(value).trim() === "";
  const wordCount = countWords(value);

  // Synchronize incoming value with contentEditable innerHTML safely
  useEffect(() => {
    if (!editorRef.current) return;

    if (isInternalChangeRef.current) {
      isInternalChangeRef.current = false;
      return;
    }

    const html = plainTextToHtml(value);
    if (editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
      lastValueRef.current = value;
    }
  }, [value]);

  // Query formatting state from current cursor or selection
  const updateFormattingState = useCallback(() => {
    if (typeof document === "undefined") return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editorRef.current) return;

    const anchor = selection.anchorNode;
    if (!anchor || !editorRef.current.contains(anchor)) {
      return;
    }

    let isBold = false;
    let isItalic = false;
    let isUnderline = false;
    let isStrike = false;
    let isBullet = false;
    let isNumber = false;
    let isQuote = false;
    let isLink = false;

    try {
      isBold = document.queryCommandState("bold");
      isItalic = document.queryCommandState("italic");
      isUnderline = document.queryCommandState("underline");
      isStrike = document.queryCommandState("strikeThrough");
      isBullet = document.queryCommandState("insertUnorderedList");
      isNumber = document.queryCommandState("insertOrderedList");
    } catch {
      // queryCommandState might not be supported in some environments
    }

    let curr: Node | null = selection.getRangeAt(0).commonAncestorContainer;
    while (curr && curr !== editorRef.current) {
      if (curr.nodeName === "BLOCKQUOTE") isQuote = true;
      if (curr.nodeName === "A") isLink = true;
      curr = curr.parentNode;
    }

    setFormatting({
      bold: isBold,
      italic: isItalic,
      underline: isUnderline,
      strike: isStrike,
      bullet: isBullet,
      number: isNumber,
      quote: isQuote,
      link: isLink,
    });
  }, []);

  // Listen to selection changes across the document
  useEffect(() => {
    const handleSelectionChange = () => {
      updateFormattingState();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [updateFormattingState]);

  // Notify parent on content edits
  const handleInput = () => {
    if (!editorRef.current) return;
    const currentHtml = editorRef.current.innerHTML;
    lastValueRef.current = currentHtml;
    isInternalChangeRef.current = true;
    onChange(currentHtml);
    updateFormattingState();
  };

  // Commands
  const execCommand = (cmd: string, val: string | undefined = undefined) => {
    editorRef.current?.focus();
    try {
      document.execCommand(cmd, false, val);
    } catch {
      // Handled safely
    }
    handleInput();
  };

  const handleBold = () => execCommand("bold");
  const handleItalic = () => execCommand("italic");
  const handleUnderline = () => execCommand("underline");
  const handleStrike = () => execCommand("strikeThrough");
  const handleBulletList = () => execCommand("insertUnorderedList");
  const handleNumberedList = () => execCommand("insertOrderedList");

  const handleQuote = () => {
    editorRef.current?.focus();
    const tag = formatting.quote ? "<p>" : "<blockquote>";
    try {
      document.execCommand("formatBlock", false, tag);
    } catch {
      // Fallback
    }
    handleInput();
  };

  const handleUndo = () => execCommand("undo");
  const handleRedo = () => execCommand("redo");

  // Save selection before opening link popover
  const handleOpenLinkPopover = (open: boolean) => {
    if (open) {
      const selection = window.getSelection();
      let text = "";
      let url = "";
      let isExisting = false;

      if (selection && selection.rangeCount > 0 && editorRef.current?.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        savedRangeRef.current = range.cloneRange();
        text = range.toString();

        let node: Node | null = range.commonAncestorContainer;
        while (node && node !== editorRef.current) {
          if (node.nodeName === "A") {
            const anchor = node as HTMLAnchorElement;
            url = anchor.getAttribute("href") || "";
            if (!text) text = anchor.textContent || "";
            isExisting = true;
            break;
          }
          node = node.parentNode;
        }
      } else {
        savedRangeRef.current = null;
      }

      setLinkUrl(url);
      setLinkText(text);
      setIsEditingExistingLink(isExisting);
    }
    setIsLinkOpen(open);
  };

  const handleApplyLink = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeUrl(linkUrl);
    if (!normalized) return;

    editorRef.current?.focus();
    const selection = window.getSelection();

    if (savedRangeRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRangeRef.current);
    }

    if (isEditingExistingLink) {
      const range = selection?.getRangeAt(0);
      let node: Node | null = range ? range.commonAncestorContainer : null;
      while (node && node !== editorRef.current) {
        if (node.nodeName === "A") {
          const anchor = node as HTMLAnchorElement;
          anchor.setAttribute("href", normalized);
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noopener noreferrer");
          if (linkText.trim()) anchor.textContent = linkText.trim();
          break;
        }
        node = node.parentNode;
      }
    } else {
      if (selection && selection.isCollapsed && linkText.trim()) {
        const aHtml = `<a href="${normalized}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText.trim())}</a>&nbsp;`;
        document.execCommand("insertHTML", false, aHtml);
      } else {
        document.execCommand("createLink", false, normalized);
        // Ensure standard attributes on newly created link
        const currentSel = window.getSelection();
        if (currentSel && currentSel.rangeCount > 0) {
          let node: Node | null = currentSel.getRangeAt(0).commonAncestorContainer;
          while (node && node !== editorRef.current) {
            if (node.nodeName === "A") {
              const a = node as HTMLAnchorElement;
              a.setAttribute("target", "_blank");
              a.setAttribute("rel", "noopener noreferrer");
              break;
            }
            node = node.parentNode;
          }
        }
      }
    }

    setIsLinkOpen(false);
    handleInput();
  };

  const handleRemoveLink = () => {
    editorRef.current?.focus();
    const selection = window.getSelection();
    if (savedRangeRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRangeRef.current);
    }
    document.execCommand("unlink", false);
    setIsLinkOpen(false);
    handleInput();
  };

  // Keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      handleBold();
    } else if (isMod && e.key.toLowerCase() === "i") {
      e.preventDefault();
      handleItalic();
    } else if (isMod && e.key.toLowerCase() === "u") {
      e.preventDefault();
      handleUnderline();
    } else if (isMod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      handleOpenLinkPopover(true);
    }
  };

  const buttonClass = (isActive: boolean) =>
    cn(
      "size-7 rounded-lg grid place-items-center transition-all text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400 select-none",
      isActive
        ? "bg-[#4f46e5]/30 text-[#a5b4fc] border border-[#6366f1]/50 shadow-xs font-semibold"
        : "text-muted-foreground hover:bg-card hover:text-foreground"
    );

  return (
    <div
      className={cn(
        "flex-1 min-h-[320px] rounded-2xl border border-border/80 bg-card/30 flex flex-col overflow-hidden shadow-sm focus-within:border-[#4f46e5]/60 focus-within:ring-1 focus-within:ring-[#4f46e5]/30 transition-all",
        className
      )}
    >
      {/* ─── FORMATTING TOOLBAR ─── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card/50 px-3 py-2 select-none">
        {/* Rich-text formatting controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleBold}
            className={buttonClass(formatting.bold)}
            title="Bold (Ctrl+B)"
            aria-label="Bold"
            aria-pressed={formatting.bold}
          >
            <Bold className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleItalic}
            className={buttonClass(formatting.italic)}
            title="Italic (Ctrl+I)"
            aria-label="Italic"
            aria-pressed={formatting.italic}
          >
            <Italic className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleUnderline}
            className={buttonClass(formatting.underline)}
            title="Underline (Ctrl+U)"
            aria-label="Underline"
            aria-pressed={formatting.underline}
          >
            <Underline className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleStrike}
            className={buttonClass(formatting.strike)}
            title="Strikethrough"
            aria-label="Strikethrough"
            aria-pressed={formatting.strike}
          >
            <Strikethrough className="size-3.5" />
          </button>

          <div className="h-4 w-px bg-border/60 mx-1" />

          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleBulletList}
            className={buttonClass(formatting.bullet)}
            title="Bullet list"
            aria-label="Bullet list"
            aria-pressed={formatting.bullet}
          >
            <List className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleNumberedList}
            className={buttonClass(formatting.number)}
            title="Numbered list"
            aria-label="Numbered list"
            aria-pressed={formatting.number}
          >
            <ListOrdered className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleQuote}
            className={buttonClass(formatting.quote)}
            title="Quote"
            aria-label="Quote"
            aria-pressed={formatting.quote}
          >
            <Quote className="size-3.5" />
          </button>

          {/* Hyperlink Popover */}
          <Popover open={isLinkOpen} onOpenChange={handleOpenLinkPopover}>
            <PopoverTrigger asChild>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                className={buttonClass(formatting.link || isLinkOpen)}
                title="Insert link (Ctrl+K)"
                aria-label="Insert link"
                aria-pressed={formatting.link}
              >
                <LinkIcon className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              sideOffset={6}
              className="w-80 p-3 rounded-xl border-border bg-[#101726] shadow-2xl text-xs space-y-2.5 z-50"
            >
              <div className="flex items-center justify-between border-b border-border/50 pb-1.5">
                <span className="font-semibold text-foreground text-xs">
                  {isEditingExistingLink ? "Edit Hyperlink" : "Insert Hyperlink"}
                </span>
                <button
                  type="button"
                  onClick={() => setIsLinkOpen(false)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <form onSubmit={handleApplyLink} className="space-y-2">
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground font-medium">Text (Optional)</label>
                  <Input
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                    placeholder="e.g. Visit our website"
                    className="h-8 text-xs bg-card/60 border-border/70"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground font-medium">URL</label>
                  <Input
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="https://example.com"
                    autoFocus
                    required
                    className="h-8 text-xs bg-card/60 border-border/70"
                  />
                </div>

                <div className="flex items-center justify-between pt-1">
                  {isEditingExistingLink ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemoveLink}
                      className="h-7 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-2 gap-1"
                    >
                      <Trash2 className="size-3" />
                      <span>Remove</span>
                    </Button>
                  ) : (
                    <div />
                  )}

                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsLinkOpen(false)}
                      className="h-7 text-xs text-muted-foreground hover:text-foreground px-2.5"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      className="h-7 text-xs bg-[#4f46e5] hover:bg-[#4338ca] text-white px-3 gap-1"
                    >
                      <Check className="size-3" />
                      <span>{isEditingExistingLink ? "Save" : "Insert"}</span>
                    </Button>
                  </div>
                </div>
              </form>
            </PopoverContent>
          </Popover>

          <div className="h-4 w-px bg-border/60 mx-1" />

          {/* Undo / Redo */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleUndo}
            className={buttonClass(false)}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleRedo}
            className={buttonClass(false)}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            <Redo2 className="size-3.5" />
          </button>
        </div>

        {/* Inline Transformation Actions (Rewrite / Expand / Shorten) */}
        {onRewrite && (
          <div className="flex items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => void onRewrite("rewrite")}
              disabled={isGenerating || isVisuallyEmpty}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Wand2 className="size-3" />
              <span>Rewrite</span>
            </button>
            <button
              type="button"
              onClick={() => void onRewrite("expand")}
              disabled={isGenerating || isVisuallyEmpty}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Plus className="size-3" />
              <span>Expand</span>
            </button>
            <button
              type="button"
              onClick={() => void onRewrite("shorten")}
              disabled={isGenerating || isVisuallyEmpty}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-40 transition-colors"
            >
              <Minus className="size-3" />
              <span>Shorten</span>
            </button>
          </div>
        )}
      </div>

      {/* ─── EDITABLE CONTENT AREA ─── */}
      <div className="relative flex-1 flex flex-col min-h-[180px]">
        {/* Placeholder when content is empty */}
        {isVisuallyEmpty && (
          <div className="pointer-events-none absolute left-4 top-4 text-sm text-muted-foreground/40 font-sans select-none">
            {placeholder}
          </div>
        )}

        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyUp={updateFormattingState}
          onMouseUp={updateFormattingState}
          onSelect={updateFormattingState}
          onKeyDown={handleKeyDown}
          role="textbox"
          aria-multiline="true"
          aria-label="Message content"
          className={cn(
            "flex-1 w-full bg-transparent p-4 text-sm leading-relaxed text-foreground resize-none outline-none font-sans overflow-y-auto",
            "[&_b]:font-bold [&_strong]:font-bold [&_b]:text-white [&_strong]:text-white",
            "[&_i]:italic [&_em]:italic",
            "[&_u]:underline [&_u]:underline-offset-2",
            "[&_s]:line-through [&_strike]:line-through [&_del]:line-through [&_s]:opacity-80 [&_strike]:opacity-80 [&_del]:opacity-80",
            "[&_a]:text-indigo-400 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-indigo-300 [&_a]:cursor-pointer",
            "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2",
            "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2",
            "[&_li]:mb-1",
            "[&_blockquote]:border-l-2 [&_blockquote]:border-indigo-500 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-2",
            "[&_p]:mb-2 last:[&_p]:mb-0"
          )}
        />
      </div>

      {/* ─── STATUS BAR ─── */}
      <div className="flex items-center justify-end px-4 py-2 border-t border-border/40 text-[11px] text-muted-foreground select-none">
        <span>{wordCount} words</span>
      </div>
    </div>
  );
}
