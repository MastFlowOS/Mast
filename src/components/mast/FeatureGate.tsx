import React from "react";
import { usePermissions } from "@/hooks/use-permissions";
import { type FeatureId } from "@/lib/permissions";
import { LockedFeatureOverlay } from "./LockedFeatureOverlay";
import { LockedFeatureCard } from "./LockedFeatureCard";

interface FeatureGateProps {
  feature: FeatureId;
  children: React.ReactNode;
  fallback?: "overlay" | "card" | "hide";
}

export function FeatureGate({
  feature,
  children,
  fallback = "overlay",
}: FeatureGateProps) {
  const { permissions, isLoading } = usePermissions();

  if (isLoading) {
    return <div className="animate-pulse bg-muted/20 min-h-[100px] w-full rounded-2xl" />;
  }

  if (permissions.can(feature)) {
    return <>{children}</>;
  }

  if (fallback === "hide") {
    return null;
  }

  if (fallback === "card") {
    const meta = permissions.getFeatureMetadata(feature);
    return (
      <LockedFeatureCard
        featureName={meta.title}
        requiredPlan={meta.requiredPlan}
        description={meta.description}
        valueProposition={meta.upgradeCTA || `Upgrade to unlock ${meta.title}`}
      />
    );
  }

  // "overlay" mode (wraps and blurs content)
  return <LockedFeatureOverlay feature={feature}>{children}</LockedFeatureOverlay>;
}
