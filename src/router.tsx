import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // The dashboard's <main> (not the window) is what scrolls. Without this the router carries
    // its scroll position from one tab to the next; this makes every navigation start at the top.
    scrollToTopSelectors: ["main"],
    defaultPreloadStaleTime: 30_000,
  });

  return router;
};
