import { Globe, Instagram, Mail, Phone } from "lucide-react";

const channels = [
  { id: "email" as const, label: "Email", icon: Mail },
  { id: "instagram" as const, label: "Instagram", icon: Instagram },
  { id: "phone" as const, label: "Phone", icon: Phone },
  { id: "contact_form" as const, label: "Form", icon: Globe },
];

export function ChannelSelector({
  value,
  onChange,
}: {
  value: "email" | "instagram" | "phone" | "contact_form";
  onChange: (value: "email" | "instagram" | "phone" | "contact_form") => void;
}) {
  return (
    <div className="flex items-center rounded-lg border border-border bg-muted/30 p-1 gap-1">
      {channels.map((ch) => {
        const active = value === ch.id;
        return (
          <button
            key={ch.id}
            onClick={() => onChange(ch.id)}
            className={
              active
                ? "flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-background border border-border text-foreground text-xs font-medium shadow-sm"
                : "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
            }
          >
            <ch.icon className="size-4" />
            {ch.label}
          </button>
        );
      })}
    </div>
  );
}
