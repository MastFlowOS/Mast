import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Search, Filter, Plus } from "lucide-react";
import { ApiError, type Lead } from "@/lib/api";
import { useCreateLead, useLeads } from "@/hooks/use-mast-api";

export const Route = createFileRoute("/dashboard/crm")({
  head: () => ({ meta: [{ title: "CRM — Mast" }] }),
  component: CRM,
});

function CRM() {
  const [search, setSearch] = useState("");
  const { data: leadsPayload, isLoading } = useLeads({ search, limit: 250 });
  const createLead = useCreateLead();
  const leads = normalizeLeads(leadsPayload);
  const stages = buildStages(leads);

  const addLead = async () => {
    const businessName = window.prompt("Business name");
    if (!businessName?.trim()) return;
    try {
      await createLead.mutateAsync({ businessName: businessName.trim(), source: "manual" });
      toast.success("Lead added");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not add lead");
    }
  };

  return (
    <div className="p-8 max-w-[1600px]">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">CRM</h1>
          <p className="text-sm text-muted-foreground">Move outreach-ready leads through email, phone, and social channels.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2">
            <Search className="size-4 text-muted-foreground" />
            <input
              className="bg-transparent outline-none text-sm w-48 placeholder:text-muted-foreground"
              placeholder="Search leads"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button className="px-3 py-2 rounded-lg border border-border hover:bg-card text-sm inline-flex items-center gap-2">
            <Filter className="size-4" /> Filter
          </button>
          <button
            onClick={addLead}
            className="px-4 py-2 rounded-lg bg-brand text-brand-foreground text-sm font-semibold shadow-brand inline-flex items-center gap-2 hover:bg-brand-dark"
          >
            <Plus className="size-4" /> Add Lead
          </button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading CRM...</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {stages.map((s) => (
          <div key={s.name} className="bg-card border border-border rounded-2xl p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 text-[10px] rounded border font-bold uppercase tracking-wider ${s.color}`}>
                  {s.name}
                </span>
                <span className="text-xs text-muted-foreground">{s.leads.length}</span>
              </div>
            </div>
            <div className="space-y-3">
              {s.leads.map((l) => (
                <div key={l.co} className="bg-background border border-border rounded-xl p-4 hover:border-muted-foreground/40 transition-colors cursor-grab">
                  <p className="font-semibold text-sm">{l.co}</p>
                  <p className="text-xs text-muted-foreground mt-1">{l.contact}</p>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs font-mono text-brand">{l.value}</span>
                    <div className="size-6 rounded-full bg-brand/15 text-brand grid place-items-center text-[10px] font-bold">
                      {l.contact.split(" ").map((p) => p[0]).join("")}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function normalizeLeads(payload: Lead[] | { leads?: Lead[] } | undefined) {
  return Array.isArray(payload) ? payload : payload?.leads ?? [];
}

function stageForStatus(status: string) {
  if (status === "closed") return "Won";
  if (status === "replied" || status === "interested") return "Replied";
  if (status.includes("sent") || status === "contacted" || status === "follow_up_due") return "Contacted";
  return "New";
}

function buildStages(leads: Lead[]) {
  const base = [
    { name: "New", color: "bg-blue-500/10 text-blue-400 border-blue-500/20", leads: [] as Array<{ co: string; contact: string; value: string }> },
    { name: "Contacted", color: "bg-warning/10 text-warning border-warning/20", leads: [] as Array<{ co: string; contact: string; value: string }> },
    { name: "Replied", color: "bg-brand/10 text-brand border-brand/20", leads: [] as Array<{ co: string; contact: string; value: string }> },
    { name: "Won", color: "bg-success/10 text-success border-success/20", leads: [] as Array<{ co: string; contact: string; value: string }> },
  ];
  const byName = new Map(base.map((stage) => [stage.name, stage]));

  for (const lead of leads) {
    const stage = byName.get(stageForStatus(lead.status)) ?? base[0];
    stage.leads.push({
      co: lead.businessName,
      contact: lead.email || lead.instagramHandle || lead.website || "No contact yet",
      value: lead.priority === "high" ? "High" : lead.priority === "normal" ? "Normal" : "Lead",
    });
  }

  return base;
}
