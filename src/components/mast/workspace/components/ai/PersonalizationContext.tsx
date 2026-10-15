import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal, Edit3, Check } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import type { PersonalizationState } from "./types";

interface PersonalizationContextProps {
  personalization: PersonalizationState;
  setPersonalization: React.Dispatch<React.SetStateAction<PersonalizationState>>;
  customContextNotes: string;
  setCustomContextNotes: React.Dispatch<React.SetStateAction<string>>;
}

const STORAGE_KEY = "mast:ai-personalization-collapsed";

export function PersonalizationContext({
  personalization,
  setPersonalization,
  customContextNotes,
  setCustomContextNotes,
}: PersonalizationContextProps) {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const [editingNotes, setEditingNotes] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(isCollapsed));
    } catch {
      // ignore storage errors
    }
  }, [isCollapsed]);

  const activeCount = Object.values(personalization).filter(Boolean).length;
  const hasCustomNotes = customContextNotes.trim().length > 0;

  return (
    <div className="border-t border-border/60 bg-[#0d121d] select-none transition-all duration-200">
      {/* Header with accessible collapse/expand trigger */}
      <div className="flex items-center justify-between px-3 py-2 bg-card/25 border-b border-border/40">
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          aria-expanded={!isCollapsed}
          aria-controls="personalization-context-panel"
          className="flex items-center gap-1.5 text-left group focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 rounded min-w-0"
        >
          <div className="size-5 rounded-md bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 grid place-items-center group-hover:bg-indigo-500/20 transition-colors shrink-0">
            <SlidersHorizontal className="size-3" />
          </div>
          <span className="text-xs font-semibold text-foreground group-hover:text-white transition-colors truncate">
            Personalization Context
          </span>
          <span className="text-[10px] font-mono font-medium px-1.5 py-0.2 rounded bg-border/50 text-muted-foreground shrink-0">
            {activeCount}/5
          </span>
          {hasCustomNotes && (
            <span className="text-[9px] font-medium px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-300 shrink-0">
              Notes
            </span>
          )}
        </button>

        <div className="flex items-center gap-1 shrink-0 ml-1">
          {!isCollapsed && (
            <button
              type="button"
              onClick={() => setEditingNotes((prev) => !prev)}
              aria-label={editingNotes ? "Done editing context notes" : "Edit context notes"}
              className={`text-[10px] font-medium px-2 py-0.5 rounded-md border transition-colors flex items-center gap-1 ${
                editingNotes
                  ? "border-indigo-500/80 bg-indigo-500/20 text-indigo-300"
                  : "border-border/50 bg-card/40 text-muted-foreground hover:text-foreground hover:bg-card/70"
              }`}
            >
              {editingNotes ? (
                <>
                  <Check className="size-2.5" />
                  <span>Done</span>
                </>
              ) : (
                <>
                  <Edit3 className="size-2.5" />
                  <span>Edit</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsCollapsed((prev) => !prev)}
            aria-label={isCollapsed ? "Expand personalization context" : "Collapse personalization context"}
            aria-expanded={!isCollapsed}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-card/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
          >
            {isCollapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* Collapsible Content */}
      {!isCollapsed && (
        <div
          id="personalization-context-panel"
          className="px-3 pb-2.5 pt-1.5 space-y-2 animate-accordion-down max-h-56 overflow-y-auto"
        >
          {editingNotes && (
            <div className="space-y-1">
              <label
                htmlFor="custom-context-notes-input"
                className="text-[10px] font-medium text-muted-foreground block"
              >
                Custom business context notes (passed to AI):
              </label>
              <Textarea
                id="custom-context-notes-input"
                value={customContextNotes}
                onChange={(e) => setCustomContextNotes(e.target.value)}
                placeholder="e.g. Founded in 2018, opened a second location, focus on specialty coffee..."
                className="min-h-14 text-xs bg-background/60 border-border/60 rounded-lg resize-none placeholder:text-muted-foreground/50 focus-visible:ring-indigo-500/40"
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-0.5 text-xs">
            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-1 px-1.5 rounded-md hover:bg-card/40 transition-colors">
              <Checkbox
                checked={personalization.businessNameAndNiche}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, businessNameAndNiche: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Business name and niche</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-1 px-1.5 rounded-md hover:bg-card/40 transition-colors">
              <Checkbox
                checked={personalization.recentInstagramActivity}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, recentInstagramActivity: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Recent Instagram activity</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-1 px-1.5 rounded-md hover:bg-card/40 transition-colors">
              <Checkbox
                checked={personalization.locationAndLocalMarket}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, locationAndLocalMarket: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Location and local market</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-1 px-1.5 rounded-md hover:bg-card/40 transition-colors">
              <Checkbox
                checked={personalization.businessReviewsAndReputation}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, businessReviewsAndReputation: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Business reviews and reputation</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-1 px-1.5 rounded-md hover:bg-card/40 transition-colors">
              <Checkbox
                checked={personalization.similarBusinessSuccessStories}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, similarBusinessSuccessStories: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Similar business success stories</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
