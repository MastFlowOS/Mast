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
    <div className="border-t border-border/70 bg-card/25 select-none transition-all duration-200">
      {/* Header with accessible collapse/expand trigger */}
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setIsCollapsed((prev) => !prev)}
          aria-expanded={!isCollapsed}
          aria-controls="personalization-context-panel"
          className="flex items-center gap-2 text-left group focus:outline-none focus-visible:ring-1 focus-visible:ring-brand rounded"
        >
          <div className="size-5 rounded bg-indigo-500/10 text-indigo-400 grid place-items-center group-hover:bg-indigo-500/20 transition-colors">
            <SlidersHorizontal className="size-3" />
          </div>
          <span className="text-xs font-semibold text-foreground group-hover:text-white transition-colors">
            Personalization Context
          </span>
          <span className="text-[10px] font-medium px-1.5 py-0.2 rounded-full bg-border/60 text-muted-foreground">
            {activeCount}/5
          </span>
          {hasCustomNotes && (
            <span className="text-[9px] font-medium px-1 py-0.2 rounded bg-indigo-500/20 text-indigo-300">
              Notes
            </span>
          )}
        </button>

        <div className="flex items-center gap-1.5">
          {!isCollapsed && (
            <button
              type="button"
              onClick={() => setEditingNotes((prev) => !prev)}
              aria-label={editingNotes ? "Done editing context notes" : "Edit context notes"}
              className={`text-[10px] font-medium px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${
                editingNotes
                  ? "border-brand/60 bg-brand/15 text-brand"
                  : "border-border/60 bg-card/50 text-muted-foreground hover:text-foreground"
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
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-card/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
          >
            {isCollapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* Collapsible Content */}
      {!isCollapsed && (
        <div
          id="personalization-context-panel"
          className="px-3.5 pb-3 space-y-2.5 pt-0.5 animate-accordion-down"
        >
          {editingNotes && (
            <div className="space-y-1">
              <label
                htmlFor="custom-context-notes-input"
                className="text-[10px] font-medium text-muted-foreground"
              >
                Custom business context notes (passed to AI):
              </label>
              <Textarea
                id="custom-context-notes-input"
                value={customContextNotes}
                onChange={(e) => setCustomContextNotes(e.target.value)}
                placeholder="e.g. Founded in 2018, opened a second location, focus on specialty coffee..."
                className="min-h-14 text-xs bg-background/60 border-border/70 rounded-lg resize-none placeholder:text-muted-foreground/60 focus-visible:ring-brand/40"
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-1.5 text-xs">
            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-0.5">
              <Checkbox
                checked={personalization.businessNameAndNiche}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, businessNameAndNiche: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Business name and niche</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-0.5">
              <Checkbox
                checked={personalization.recentInstagramActivity}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, recentInstagramActivity: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Recent Instagram activity</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-0.5">
              <Checkbox
                checked={personalization.locationAndLocalMarket}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, locationAndLocalMarket: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Location and local market</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-0.5">
              <Checkbox
                checked={personalization.businessReviewsAndReputation}
                onCheckedChange={(c) =>
                  setPersonalization((prev) => ({ ...prev, businessReviewsAndReputation: Boolean(c) }))
                }
                className="size-3.5 rounded border-border/80 data-[state=checked]:bg-[#4f46e5] data-[state=checked]:border-[#4f46e5]"
              />
              <span className="text-[11px] leading-tight">Business reviews and reputation</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground py-0.5">
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
