/**
 * Truthful Website Reachability Derivation.
 *
 * Rules:
 * 1. An explicit boolean `signals.website_reachable` (or direct site reachability) takes precedence.
 * 2. If that value is absent, an explicit boolean `contactAudit.homepage_fetch_failed` is inverted.
 * 3. If neither source provides a boolean, reachability remains `undefined`.
 * 4. A website URL existing in the database must NOT automatically mean the website is reachable.
 */

export function deriveWebsiteReachable(
  signalsOrEnriched?: Record<string, unknown> | null,
  siteReachable?: boolean | null
): boolean | undefined {
  if (typeof siteReachable === "boolean") {
    return siteReachable;
  }
  if (!signalsOrEnriched || typeof signalsOrEnriched !== "object") {
    return undefined;
  }
  const signalsObj =
    signalsOrEnriched.signals && typeof signalsOrEnriched.signals === "object"
      ? (signalsOrEnriched.signals as Record<string, unknown>)
      : signalsOrEnriched;
  const sigReachable = signalsObj?.website_reachable;
  if (typeof sigReachable === "boolean") {
    return sigReachable;
  }
  const contactAudit =
    signalsObj?.contact_audit && typeof signalsObj.contact_audit === "object"
      ? (signalsObj.contact_audit as Record<string, unknown>)
      : undefined;
  if (typeof contactAudit?.homepage_fetch_failed === "boolean") {
    return !contactAudit.homepage_fetch_failed;
  }
  return undefined;
}
