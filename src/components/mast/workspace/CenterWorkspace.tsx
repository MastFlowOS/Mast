import { TabsContainer } from "./TabsContainer";
import type { Lead } from "@/lib/api";
import type { Channel } from "@/routes/dashboard.leads.$leadId";

interface CenterWorkspaceProps {
  lead: Lead;
  channel: Channel;
  setChannel: (c: Channel) => void;
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
}

export function CenterWorkspace(props: CenterWorkspaceProps) {
  return (
    <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background">
      <TabsContainer {...props} />
    </main>
  );
}
