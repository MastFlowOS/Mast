import React from "react";
import { Link } from "@tanstack/react-router";
import { Lock, ArrowRight, Sparkles, Search, Network, Bell, Kanban, Upload, Mail, Phone, Instagram, Link2, Navigation, Globe2, Zap, Brain, FileText, TrendingUp, Eye } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { type FeatureId } from "@/lib/permissions";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Network,
  Bell,
  Kanban,
  Upload,
  Mail,
  Phone,
  Instagram,
  Link2,
  Navigation,
  Globe2,
  Zap,
  Sparkles,
  Search,
  Brain,
  FileText,
  TrendingUp,
  Eye,
  Lock,
};

interface LockedFeatureOverlayProps {
  feature: FeatureId;
  children: React.ReactNode;
}

export function LockedFeatureOverlay({ feature, children }: LockedFeatureOverlayProps) {
  const { permissions } = usePermissions();
  const meta = permissions.getFeatureMetadata(feature);
  const planName = meta.requiredPlan.charAt(0).toUpperCase() + meta.requiredPlan.slice(1);

  // Dynamically resolve icon, fallback to Lock
  const IconComponent = (meta.icon && ICON_MAP[meta.icon]) || Lock;

  return (
    <div className="relative overflow-hidden group w-full h-full min-h-[300px]">
      {/* Blurred Children */}
      <div className="blur-[6px] pointer-events-none select-none filter opacity-30 transition-all duration-300 w-full h-full">
        {children}
      </div>

      {/* Lock Overlay */}
      <div className="absolute inset-0 bg-background/30 backdrop-blur-sm flex items-center justify-center p-6 z-10 animate-fade-in">
        <div className="w-full max-w-sm bg-card/75 border border-brand/20 rounded-3xl p-6 shadow-2xl text-center space-y-4 backdrop-blur-md">
          <div className="mx-auto size-12 rounded-xl bg-brand/10 border border-brand/20 flex items-center justify-center">
            <IconComponent className="size-5 text-brand" />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-center gap-1.5">
              <h4 className="font-bold text-sm text-foreground">{meta.title}</h4>
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider bg-brand/15 text-brand border border-brand/25">
                <Sparkles className="size-2.5" /> Premium
              </span>
            </div>
            <p className="text-[10px] font-bold text-brand uppercase tracking-wider">
              Requires {planName} Plan
            </p>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            {meta.description}
          </p>

          <Link
            to="/dashboard/subscription"
            className="group flex w-full items-center justify-center gap-2 rounded-xl bg-foreground text-background py-2.5 text-xs font-bold transition-all hover:bg-foreground/90 active:scale-[0.99] cursor-pointer"
          >
            <span>Upgrade to {planName}</span>
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
