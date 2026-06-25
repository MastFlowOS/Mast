/**
 * PageTransition
 *
 * Wraps the <Outlet /> in dashboard.tsx to apply a consistent page-level
 * entrance animation whenever the route changes.
 *
 * Uses the route pathname as the React key so the component fully unmounts
 * and remounts on navigation, triggering the CSS animation from scratch.
 *
 * Animation: page-enter (fade + subtle translateY + blur) defined in styles.css.
 *
 * Usage:
 *   <PageTransition>
 *     <Outlet />
 *   </PageTransition>
 */

import { useRouterState } from "@tanstack/react-router";

interface PageTransitionProps {
  children: React.ReactNode;
}

export function PageTransition({ children }: PageTransitionProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div key={pathname} className="animate-page-enter h-full">
      {children}
    </div>
  );
}
