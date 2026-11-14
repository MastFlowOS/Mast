import { useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * MAST Dynamic Island — State & Priority Engine
 *
 * Manages structured real-time header events and resolves the single
 * highest-priority event to display in the header's center Dynamic Island.
 *
 * Visual & behavioral contract:
 *   - Quiet when nothing is happening (`idle` -> completely empty center well)
 *   - Only ONE primary event occupies the Dynamic Island at a time
 *   - Strict priority hierarchy:
 *       1. Critical errors / failed operations (`discovery_error`)
 *       2. Active discovery (`discovery_active`)
 *       3. Action-required notifications (`notification`)
 *       4. Completed operations (`discovery_complete`, `import_complete`)
 *       5. Informational / attention events (`credits_low`)
 *       6. Idle (`idle`)
 */

export type DynamicIslandEventType =
  | "idle"
  | "discovery_active"
  | "discovery_complete"
  | "notification"
  | "import_complete"
  | "credits_low"
  | "discovery_error";

export type DynamicIslandIconKind =
  | "progress"
  | "check"
  | "bell"
  | "import"
  | "credits"
  | "error";

export type DynamicIslandEventStatus =
  | "active"
  | "unread"
  | "completed"
  | "dismissed";

export interface DynamicIslandEvent {
  id: string;
  type: DynamicIslandEventType;
  priority: number;
  title: string;
  description?: string;
  icon?: DynamicIslandIconKind;
  /** Progress percentage (0 - 100) for `discovery_active` */
  progress?: number;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  timestamp: number;
  status: DynamicIslandEventStatus;
  /** Optional duration (ms) before a completed event transitions out of the island */
  autoDismissMs?: number;
}

export type DynamicIslandEventInput = {
  id?: string;
  type: Exclude<DynamicIslandEventType, "idle">;
  priority?: number;
  title: string;
  description?: string;
  icon?: DynamicIslandIconKind;
  progress?: number;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  timestamp?: number;
  status?: DynamicIslandEventStatus;
  autoDismissMs?: number;
};

/**
 * Priority weights (higher number = higher priority).
 * Matches the specification:
 *   1. Critical errors / failed operations (100)
 *   2. Active discovery (80)
 *   3. Action-required notifications (60)
 *   4. Completed operations (40)
 *   5. Informational / low-credits events (20)
 *   6. Idle (0)
 */
export const DYNAMIC_ISLAND_PRIORITY: Record<DynamicIslandEventType, number> = {
  discovery_error: 100,
  discovery_active: 80,
  notification: 60,
  discovery_complete: 40,
  import_complete: 40,
  credits_low: 20,
  idle: 0,
};

export const DEFAULT_ICON_FOR_TYPE: Record<
  Exclude<DynamicIslandEventType, "idle">,
  DynamicIslandIconKind
> = {
  discovery_active: "progress",
  discovery_complete: "check",
  notification: "bell",
  import_complete: "import",
  credits_low: "credits",
  discovery_error: "error",
};

export const IDLE_DYNAMIC_ISLAND_EVENT: DynamicIslandEvent = Object.freeze({
  id: "idle",
  type: "idle",
  priority: DYNAMIC_ISLAND_PRIORITY.idle,
  title: "",
  timestamp: 0,
  status: "active",
});

export function clampProgress(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Normalizes a partial event input into a full `DynamicIslandEvent`.
 */
export function createDynamicIslandEvent(
  input: DynamicIslandEventInput,
): DynamicIslandEvent {
  const priority =
    typeof input.priority === "number"
      ? input.priority
      : DYNAMIC_ISLAND_PRIORITY[input.type];
  return {
    id: input.id ?? input.type,
    type: input.type,
    priority,
    title: input.title,
    description: input.description,
    icon: input.icon ?? DEFAULT_ICON_FOR_TYPE[input.type],
    progress:
      input.type === "discovery_active" || typeof input.progress === "number"
        ? clampProgress(input.progress)
        : undefined,
    actionLabel: input.actionLabel,
    onAction: input.onAction,
    actionHref: input.actionHref,
    timestamp: input.timestamp ?? Date.now(),
    status: input.status ?? "active",
    autoDismissMs: input.autoDismissMs,
  };
}

/**
 * Pure priority resolver: selects the single highest-priority active/unread event,
 * or returns `IDLE_DYNAMIC_ISLAND_EVENT` when no events require attention.
 */
export function resolvePrimaryDynamicIslandEvent(
  events: readonly DynamicIslandEvent[],
): DynamicIslandEvent {
  const eligible = events.filter(
    (e) =>
      e.type !== "idle" &&
      (e.status === "active" || e.status === "unread"),
  );

  if (eligible.length === 0) {
    return IDLE_DYNAMIC_ISLAND_EVENT;
  }

  const sorted = [...eligible].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return b.timestamp - a.timestamp;
  });

  return sorted[0];
}

// ── Global Reactive Store for Dynamic Island Events ─────────────────────────

type Listener = () => void;

class DynamicIslandStore {
  private events = new Map<string, DynamicIslandEvent>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private dismissedKeys = new Set<string>();
  private snapshot: DynamicIslandEvent[] = [];
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DynamicIslandEvent[] => {
    return this.snapshot;
  };

  private emit() {
    this.snapshot = Array.from(this.events.values());
    for (const listener of this.listeners) {
      listener();
    }
  }

  private clearTimer(id: string) {
    const existing = this.timers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(id);
    }
  }

  publish(input: DynamicIslandEventInput): DynamicIslandEvent {
    const event = createDynamicIslandEvent(input);
    this.clearTimer(event.id);

    // When a new active discovery starts, clear any lingering discovery_complete / discovery_error
    if (event.type === "discovery_active") {
      this.remove("discovery_complete");
      this.remove("discovery_error");
    } else if (
      event.type === "discovery_complete" ||
      event.type === "discovery_error"
    ) {
      this.remove("discovery_active");
    }

    this.dismissedKeys.delete(event.id);
    this.events.set(event.id, event);

    if (event.autoDismissMs && event.autoDismissMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(event.id);
        const current = this.events.get(event.id);
        if (current && current.timestamp === event.timestamp) {
          this.events.set(event.id, { ...current, status: "completed" });
          this.emit();
        }
      }, event.autoDismissMs);
      this.timers.set(event.id, timer);
    }

    this.emit();
    return event;
  }

  updateProgress(progress: number, description?: string) {
    const existing = this.events.get("discovery_active");
    if (!existing || existing.status !== "active") return;
    const clamped = clampProgress(progress);
    if (
      existing.progress === clamped &&
      (description === undefined || existing.description === description)
    ) {
      return;
    }
    this.events.set("discovery_active", {
      ...existing,
      progress: clamped,
      ...(description !== undefined ? { description } : {}),
    });
    this.emit();
  }

  dismiss(idOrType: string) {
    this.clearTimer(idOrType);
    this.dismissedKeys.add(idOrType);
    const existing = this.events.get(idOrType);
    if (existing) {
      this.events.set(idOrType, { ...existing, status: "dismissed" });
      this.emit();
    } else {
      this.emit();
    }
  }

  isDismissed(key: string): boolean {
    return this.dismissedKeys.has(key);
  }

  remove(idOrType: string) {
    this.clearTimer(idOrType);
    if (this.events.delete(idOrType)) {
      this.emit();
    }
  }

  clearAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.events.clear();
    this.dismissedKeys.clear();
    this.emit();
  }
}

export const dynamicIslandStore = new DynamicIslandStore();

export function publishDynamicIslandEvent(
  input: DynamicIslandEventInput,
): DynamicIslandEvent {
  return dynamicIslandStore.publish(input);
}

export function updateDynamicIslandProgress(
  progress: number,
  description?: string,
): void {
  dynamicIslandStore.updateProgress(progress, description);
}

export function dismissDynamicIslandEvent(idOrType: string): void {
  dynamicIslandStore.dismiss(idOrType);
}

export function removeDynamicIslandEvent(idOrType: string): void {
  dynamicIslandStore.remove(idOrType);
}

export function clearDynamicIslandEvents(): void {
  dynamicIslandStore.clearAll();
}

/**
 * React hook returning the current resolved primary Dynamic Island event
 * by combining store-published events with optional derived ambient events
 * (such as due follow-up reminders or low-credit warnings).
 */
export function useDynamicIsland(
  ambientEvents: readonly DynamicIslandEvent[] = [],
): {
  activeEvent: DynamicIslandEvent;
  allEvents: DynamicIslandEvent[];
  dismiss: (idOrType: string) => void;
} {
  const storeEvents = useSyncExternalStore(
    dynamicIslandStore.subscribe,
    dynamicIslandStore.getSnapshot,
    dynamicIslandStore.getSnapshot,
  );

  // Listen to custom window events as well for easy cross-tree/external triggers
  useEffect(() => {
    const onCustomEvent = (e: Event) => {
      const detail = (e as CustomEvent<DynamicIslandEventInput | { type: "idle" }>).detail;
      if (!detail) return;
      if (detail.type === "idle") {
        dynamicIslandStore.clearAll();
      } else {
        dynamicIslandStore.publish(detail);
      }
    };
    window.addEventListener("mast_dynamic_island_event", onCustomEvent);
    return () => {
      window.removeEventListener("mast_dynamic_island_event", onCustomEvent);
    };
  }, []);

  const combined = useMemo(() => {
    const filteredAmbient = ambientEvents.filter(
      (e) => !dynamicIslandStore.isDismissed(e.id) && !dynamicIslandStore.isDismissed(e.type),
    );
    return [...storeEvents, ...filteredAmbient];
  }, [storeEvents, ambientEvents]);

  const activeEvent = useMemo(
    () => resolvePrimaryDynamicIslandEvent(combined),
    [combined],
  );

  return {
    activeEvent,
    allEvents: combined,
    dismiss: dismissDynamicIslandEvent,
  };
}
