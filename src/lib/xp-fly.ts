/**
 * XP "fly to milestone counter" micro-interaction.
 *
 * A completed goal card's +XP badge needs to visually travel from the card
 * to the milestone XP counter when claimed. The card and the counter live
 * in different, unrelated subtrees (`FocusGoals` / `FocusMilestones`) under
 * `FocusDashboard`, so this is implemented as a tiny imperative DOM helper
 * rather than threaded through props — the same pattern the rest of this
 * codebase uses for one-off, ephemeral effects that don't belong in React
 * state (see the toast/notification calls in use-focus-progress.ts).
 *
 * `flyXpToMilestone` clones a small "+XP" pill at the origin element's
 * position, animates it to the milestone badge's position via a single
 * fixed-position transform transition, then resolves once the flight is
 * done (or immediately if the badge isn't mounted, e.g. off-screen /
 * unmounted route). Callers await this before triggering the "arrival"
 * effects (counter bump, progress bar fill, level-up).
 */

export const MILESTONE_XP_BADGE_ID = "focus-milestone-xp-badge";

const FLIGHT_MS = 650;

export function flyXpToMilestone(originEl: HTMLElement | null, xp: number): Promise<void> {
  return new Promise((resolve) => {
    const target = document.getElementById(MILESTONE_XP_BADGE_ID);

    if (!originEl || !target || typeof window === "undefined") {
      resolve();
      return;
    }

    const from = originEl.getBoundingClientRect();
    const to = target.getBoundingClientRect();

    const pill = document.createElement("div");
    pill.textContent = `+${xp} XP`;
    pill.setAttribute("aria-hidden", "true");
    pill.className = "xp-fly-pill";
    pill.style.left = `${from.left + from.width / 2}px`;
    pill.style.top = `${from.top + from.height / 2}px`;

    document.body.appendChild(pill);

    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);

    // Force layout so the initial position is committed before we animate
    // the transform — otherwise the browser can coalesce both states into
    // one frame and the pill just appears at the destination.

    pill.getBoundingClientRect();

    requestAnimationFrame(() => {
      pill.style.transform = `translate(${dx}px, ${dy}px) scale(0.55)`;
      pill.style.opacity = "0";
    });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pill.remove();
      resolve();
    };

    pill.addEventListener("transitionend", finish, { once: true });
    // Fallback in case transitionend doesn't fire (e.g. tab backgrounded).
    window.setTimeout(finish, FLIGHT_MS + 150);
  });
}

/** Briefly flashes the milestone XP badge to mark a new total landing. */
export function bumpMilestoneBadge() {
  const target = document.getElementById(MILESTONE_XP_BADGE_ID);
  if (!target) return;
  target.classList.remove("milestone-xp-badge-bump");
  // Reflow to restart the animation if it's still playing from a rapid
  // second claim.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  target.offsetWidth;
  target.classList.add("milestone-xp-badge-bump");
  window.setTimeout(() => target.classList.remove("milestone-xp-badge-bump"), 700);
}
