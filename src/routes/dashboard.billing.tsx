import { createFileRoute } from "@tanstack/react-router";
import { Download, CreditCard } from "lucide-react";

export const Route = createFileRoute("/dashboard/billing")({
  head: () => ({ meta: [{ title: "Billing — Mast" }] }),
  component: Billing,
});

const invoices = [
  { id: "INV-0042", date: "May 14, 2026", amount: "$99.00", status: "Paid" },
  { id: "INV-0041", date: "Apr 14, 2026", amount: "$99.00", status: "Paid" },
  { id: "INV-0040", date: "Mar 14, 2026", amount: "$99.00", status: "Paid" },
  { id: "INV-0039", date: "Feb 14, 2026", amount: "$49.00", status: "Paid" },
];

function Billing() {
  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
      <p className="text-sm text-muted-foreground mt-1">Payment method and invoice history.</p>

      <div className="mt-6 bg-card border border-border rounded-2xl p-6">
        <h2 className="font-bold mb-4">Payment Method</h2>
        <div className="flex items-center justify-between p-4 rounded-xl border border-border bg-background">
          <div className="flex items-center gap-4">
            <div className="size-10 rounded-lg bg-brand/10 border border-brand/20 grid place-items-center">
              <CreditCard className="size-5 text-brand" />
            </div>
            <div>
              <p className="text-sm font-semibold">Visa ending in 4242</p>
              <p className="text-xs text-muted-foreground">Expires 12 / 2027</p>
            </div>
          </div>
          <button className="text-sm font-semibold text-brand hover:text-brand-dark">Update</button>
        </div>
      </div>

      <div className="mt-6 bg-card border border-border rounded-2xl overflow-hidden">
        <div className="p-6 border-b border-border">
          <h2 className="font-bold">Invoices</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-background/40 border-b border-border">
            <tr>
              <th className="text-left p-4 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Invoice</th>
              <th className="text-left p-4 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Date</th>
              <th className="text-left p-4 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Amount</th>
              <th className="text-left p-4 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">Status</th>
              <th className="text-right p-4 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">PDF</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv, i) => (
              <tr key={inv.id} className={i < invoices.length - 1 ? "border-b border-border/50" : ""}>
                <td className="p-4 font-mono text-xs">{inv.id}</td>
                <td className="p-4 text-muted-foreground">{inv.date}</td>
                <td className="p-4 font-medium">{inv.amount}</td>
                <td className="p-4">
                  <span className="px-2 py-0.5 text-[10px] rounded border font-bold uppercase tracking-wider bg-success/10 text-success border-success/20">
                    {inv.status}
                  </span>
                </td>
                <td className="p-4 text-right">
                  <button className="text-muted-foreground hover:text-foreground">
                    <Download className="size-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
