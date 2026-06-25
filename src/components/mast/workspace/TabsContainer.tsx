import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ComposeTab } from "./ComposeTab";
import { HistoryTab } from "./HistoryTab";
import { FollowUpsTab } from "./FollowUpsTab";
import { NotesTab } from "./NotesTab";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

interface TabsContainerProps {
  lead: Lead;
  channel: Channel;
  setChannel: (c: Channel) => void;
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
}

export function TabsContainer({
  lead,
  channel,
  setChannel,
  subject,
  setSubject,
  body,
  setBody,
}: TabsContainerProps) {
  return (
    <Tabs defaultValue="compose" className="flex flex-col flex-1 min-h-0">
      <div className="px-8 pt-5 border-b border-border shrink-0">
        <TabsList className="bg-transparent h-auto p-0 gap-1">
          {(["compose", "history", "follow-ups", "notes"] as const).map((tab) => (
            <TabsTrigger
              key={tab}
              value={tab}
              className="relative h-9 rounded-none bg-transparent px-4 pb-3 pt-2 text-sm font-medium text-muted-foreground capitalize
                data-[state=active]:text-foreground data-[state=active]:shadow-none
                data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-brand"
            >
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <div className="flex-1 overflow-y-auto">
        <TabsContent value="compose" className="mt-0 outline-none">
          <ComposeTab
            lead={lead}
            channel={channel}
            setChannel={setChannel}
            subject={subject}
            setSubject={setSubject}
            body={body}
            setBody={setBody}
          />
        </TabsContent>
        <TabsContent value="history" className="mt-0 outline-none">
          <HistoryTab lead={lead} />
        </TabsContent>
        <TabsContent value="follow-ups" className="mt-0 outline-none">
          <FollowUpsTab lead={lead} />
        </TabsContent>
        <TabsContent value="notes" className="mt-0 outline-none">
          <NotesTab lead={lead} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
