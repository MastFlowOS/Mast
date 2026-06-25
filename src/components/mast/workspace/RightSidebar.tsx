import { AIAssistant } from "./components/AIAssistant";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

interface RightSidebarProps {
  lead: Lead;
  channel: Channel;
  subject: string;
  body: string;
  onInsert: (body: string, subject?: string) => void;
}

export function RightSidebar({ lead, channel, subject, body, onInsert }: RightSidebarProps) {
  return (
    <aside className="w-full shrink-0 border-t border-border bg-card/40 lg:w-[300px] lg:border-l lg:border-t-0 xl:w-[336px]">
      <ScrollArea className="h-full">
        <div className="p-4 md:p-5">
          <AIAssistant
            lead={lead}
            channel={channel}
            subject={subject}
            body={body}
            onInsert={onInsert}
          />
        </div>
      </ScrollArea>
    </aside>
  );
}
