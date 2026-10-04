import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // The dashboard's <main> (not the window) is what scrolls. Without this the router carries
    // its scroll position from one tab to the next; this makes every navigation start at the top.
    scrollToTopSelectors: ["main"],
    defaultPreloadStaleTime: 0,
  });

  return router;
};
