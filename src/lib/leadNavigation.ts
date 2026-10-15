import type { Lead } from "./api";

export interface LeadNavigationContext {
  leadIds: number[];
  total?: number;
  source?: string;
  returnTo?: string;
  label?: string;
  updatedAt?: number;
}

const STORAGE_KEY = "mast:lead-navigation-context";

// In-memory fallback if sessionStorage is unavailable (e.g., SSR or constrained test environments)
let inMemoryContext: LeadNavigationContext | null = null;

/**
 * Stores the current active lead collection context (e.g. from Relationships, Pipeline, or Discover)
 * so that lead detail workspaces can navigate sequentially according to current filters and sort order.
 */
export function setLeadNavigationContext(context: LeadNavigationContext): void {
  const payload: LeadNavigationContext = {
    ...context,
    total: context.total ?? context.leadIds.length,
    updatedAt: Date.now(),
  };

  inMemoryContext = payload;

  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // sessionStorage unavailable or quota exceeded; inMemoryContext will serve as fallback
  }
}

/**
 * Retrieves the currently active lead navigation context if one exists.
 */
export function getLeadNavigationContext(): LeadNavigationContext | null {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LeadNavigationContext;
        if (Array.isArray(parsed?.leadIds)) {
          return parsed;
        }
      }
    }
  } catch {
    // ignore parse or storage errors
  }

  return inMemoryContext;
}

/**
 * Clears any active lead navigation context.
 */
export function clearLeadNavigationContext(): void {
  inMemoryContext = null;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Normalizes API payloads from useLeads into a clean Lead[] array.
 */
export function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined | null): Lead[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.leads) ? payload.leads : [];
}
