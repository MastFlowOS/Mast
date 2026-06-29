import { createFileRoute } from "@tanstack/react-router";
import { FocusDashboard } from "@/components/mast/focus/FocusDashboard";

export const Route = createFileRoute("/dashboard/")({
  component: DashboardHome,
});

function DashboardHome() {
  return <FocusDashboard />;
}
