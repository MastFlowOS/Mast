import { Sparkles, ChevronLeft } from "lucide-react";
import { AIAssistant } from "./components/AIAssistant";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

interface RightSidebarProps {
  lead: Lead;
  channel: Channel;
  subject: string;
  body: string;
  onInsert: (body: string, subject?: string) => void;
  template: string;
  setTemplate: (v: string) => void;
  tone: string;
  setTone: (v: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

export function RightSidebar({
  lead,
  channel,
  subject,
  body,
  onInsert,
  template,
  setTemplate,
  tone,
  setTone,
  isOpen,
  onToggle,
}: RightSidebarProps) {
  if (!isOpen) {
    return (
      <aside className="hidden lg:flex w-12 shrink-0 border-l border-border bg-[#0d121d] flex-col items-center py-4 select-none">
        <button
          type="button"
          onClick={onToggle}
          className="size-8 rounded-lg border border-border/80 bg-card/60 grid place-items-center text-muted-foreground hover:text-white hover:border-brand transition-colors"
          title="Open AI Assistant"
        >
          <Sparkles className="size-4 text-indigo-400" />
        </button>
        <span
          onClick={onToggle}
          className="cursor-pointer mt-6 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase [writing-mode:vertical-rl] rotate-180 hover:text-foreground transition-colors"
        >
          AI Assistant
        </span>
      </aside>
    );
  }

  return (
    <aside className="w-full shrink-0 border-t border-border bg-[#0d121d] lg:w-[300px] xl:w-[330px] lg:border-l lg:border-t-0 flex flex-col h-full">
      <AIAssistant
        lead={lead}
        channel={channel}
        subject={subject}
        body={body}
        onInsert={onInsert}
        template={template}
        setTemplate={setTemplate}
        tone={tone}
        setTone={setTone}
        onHide={onToggle}
      />
    </aside>
  );
}
