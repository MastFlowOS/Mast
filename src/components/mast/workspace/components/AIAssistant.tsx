import { useState, useEffect } from "react";
import { Sparkles, PenTool, Wand2, Lightbulb, Search } from "lucide-react";
import type { AssistantTab, PersonalizationState, GeneratedDraft, AIAssistantProps } from "./ai/types";
import { WriteTab } from "./ai/WriteTab";
import { ImproveTab } from "./ai/ImproveTab";
import { IdeasTab } from "./ai/IdeasTab";
import { ResearchTab } from "./ai/ResearchTab";
import { PersonalizationContext } from "./ai/PersonalizationContext";

export function AIAssistant({
  lead,
  channel,
  subject,
  body,
  onInsert,
  template,
  setTemplate,
  tone,
  setTone,
  onHide,
}: AIAssistantProps) {
  const [activeTab, setActiveTab] = useState<AssistantTab>("write");

  // Write tab persistent state
  const [writeCustomInstructions, setWriteCustomInstructions] = useState("");
  const [generatedDraft, setGeneratedDraft] = useState<GeneratedDraft | null>(null);

  // Improve tab persistent state
  const [improveCustomInstruction, setImproveCustomInstruction] = useState("");
  const [improvedDraft, setImprovedDraft] = useState<GeneratedDraft | null>(null);

  // Ideas tab persistent state
  const [ideasTopic, setIdeasTopic] = useState("");

  // Research tab persistent state
  const [researchQuestion, setResearchQuestion] = useState("");

  // Personalization context state
  const [personalization, setPersonalization] = useState<PersonalizationState>({
    businessNameAndNiche: true,
    recentInstagramActivity: true,
    locationAndLocalMarket: true,
    businessReviewsAndReputation: true,
    similarBusinessSuccessStories: true,
  });
  const [customContextNotes, setCustomContextNotes] = useState("");

  // Lead switching isolation: prevent lead A's drafted messages from leaking into lead B
  const [activeLeadId, setActiveLeadId] = useState<number>(lead.id);

  useEffect(() => {
    if (lead.id !== activeLeadId) {
      setActiveLeadId(lead.id);
      // Clear lead-specific generated text
      setGeneratedDraft(null);
      setImprovedDraft(null);
      setResearchQuestion("");
    }
  }, [lead.id, activeLeadId]);

  const tabs: { id: AssistantTab; label: string; icon: any }[] = [
    { id: "write", label: "Write", icon: PenTool },
    { id: "improve", label: "Improve", icon: Wand2 },
    { id: "ideas", label: "Ideas", icon: Lightbulb },
    { id: "research", label: "Research", icon: Search },
  ];

  return (
    <div className="flex flex-col h-full bg-[#0d121d] text-foreground select-none overflow-hidden">
      {/* ─── HEADER: Title + Hide button ─── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/70 shrink-0">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-lg bg-indigo-500/15 text-indigo-400 grid place-items-center">
            <Sparkles className="size-3.5" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-foreground leading-none">AI Assistant</h3>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-none">
              Outreach Workspace Copilot
            </p>
          </div>
        </div>
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-card/50"
          >
            Hide
          </button>
        )}
      </div>

      {/* ─── ACCESSIBLE TABS NAVIGATION: Write, Improve, Ideas, Research ─── */}
      <div className="p-3 border-b border-border/50 shrink-0">
        <div
          role="tablist"
          aria-label="AI Assistant workspaces"
          className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-card/60 border border-border/60"
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                role="tab"
                id={`assistant-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`assistant-panel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`py-1.5 px-1 rounded-lg text-xs font-medium capitalize transition-all flex items-center justify-center gap-1 ${
                  isActive
                    ? "bg-[#4f46e5] text-white shadow-sm font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-card/40"
                }`}
              >
                <Icon className={`size-3 shrink-0 ${isActive ? "text-white" : "text-muted-foreground"}`} />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── ACTIVE TAB PANEL (SCROLLABLE WORKSPACE) ─── */}
      <div
        role="tabpanel"
        id={`assistant-panel-${activeTab}`}
        aria-labelledby={`assistant-tab-${activeTab}`}
        className="flex-1 overflow-y-auto p-3.5"
      >
        {activeTab === "write" && (
          <WriteTab
            lead={lead}
            channel={channel}
            composerSubject={subject}
            composerBody={body}
            onInsert={onInsert}
            template={template}
            setTemplate={setTemplate}
            tone={tone}
            setTone={setTone}
            personalization={personalization}
            customContextNotes={customContextNotes}
            generatedDraft={generatedDraft}
            setGeneratedDraft={setGeneratedDraft}
            customInstructions={writeCustomInstructions}
            setCustomInstructions={setWriteCustomInstructions}
          />
        )}

        {activeTab === "improve" && (
          <ImproveTab
            lead={lead}
            channel={channel}
            composerSubject={subject}
            composerBody={body}
            onInsert={onInsert}
            tone={tone}
            setTone={setTone}
            personalization={personalization}
            customContextNotes={customContextNotes}
            onNavigateToWrite={() => setActiveTab("write")}
            improvedDraft={improvedDraft}
            setImprovedDraft={setImprovedDraft}
            customInstruction={improveCustomInstruction}
            setCustomInstruction={setImproveCustomInstruction}
          />
        )}

        {activeTab === "ideas" && (
          <IdeasTab
            lead={lead}
            onInsert={onInsert}
            composerBody={body}
            topic={ideasTopic}
            setTopic={setIdeasTopic}
          />
        )}

        {activeTab === "research" && (
          <ResearchTab
            lead={lead}
            researchQuestion={researchQuestion}
            setResearchQuestion={setResearchQuestion}
          />
        )}
      </div>

      {/* ─── COLLAPSIBLE PERSONALIZATION CONTEXT (BOTTOM) ─── */}
      <div className="shrink-0">
        <PersonalizationContext
          personalization={personalization}
          setPersonalization={setPersonalization}
          customContextNotes={customContextNotes}
          setCustomContextNotes={setCustomContextNotes}
        />
      </div>
    </div>
  );
}
