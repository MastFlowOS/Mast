import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarCheck2, Check, Copy, ExternalLink, Loader2, Save } from "lucide-react";
import {
  useBookingSettings,
  useMe,
  useSaveBookingSettings,
} from "@/hooks/use-mast-api";
import { getPublicBackendBaseUrl, type BookingProvider } from "@/lib/api";

export function BookingSyncCard() {
  const { data: auth } = useMe();
  const bookingQuery = useBookingSettings(!!auth?.user);
  const saveBooking = useSaveBookingSettings();

  const [provider, setProvider] = useState<BookingProvider>("calcom");
  const [bookingUrl, setBookingUrl] = useState("");
  const [autoMoveStage, setAutoMoveStage] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!bookingQuery.data) return;
    setProvider(bookingQuery.data.provider);
    setBookingUrl(bookingQuery.data.bookingUrl ?? "");
    setAutoMoveStage(bookingQuery.data.autoMoveStage);
  }, [bookingQuery.data]);

  const backendBase = getPublicBackendBaseUrl();
  const webhookUrl = bookingQuery.data?.webhookToken
    ? `${backendBase || "https://your-mast-api.example.com"}/v1/booking/webhook/${bookingQuery.data.webhookToken}`
    : "";

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await saveBooking.mutateAsync({
        provider,
        bookingUrl: bookingUrl.trim(),
        autoMoveStage,
      });
      toast.success("Booking link settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save booking settings");
    }
  };

  const handleCopyWebhook = async () => {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Webhook URL copied");
    } catch {
      toast.error("Could not copy webhook URL");
    }
  };

  return (
    <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 grid place-items-center shrink-0">
            <CalendarCheck2 className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Booking Link Sync (Cal.com &amp; Calendly)</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Connect your calendar link so AI can drop it into warm replies and automatically move leads to{" "}
              <span className="text-foreground font-medium">Meeting Booked</span> when they book a call.
            </p>
          </div>
        </div>

        {bookingQuery.data?.lastEventAt && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 self-start sm:self-auto">
            Last booking synced {new Date(bookingQuery.data.lastEventAt).toLocaleDateString()}
          </span>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Booking Platform
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as BookingProvider)}
              className="w-full bg-background border border-border/80 focus:border-emerald-500 outline-none px-3 py-2.5 rounded-xl text-sm"
            >
              <option value="calcom">Cal.com</option>
              <option value="calendly">Calendly</option>
              <option value="custom">Custom Webhook</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
              Your Booking Link
            </label>
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={bookingUrl}
                onChange={(e) => setBookingUrl(e.target.value)}
                placeholder={provider === "calendly" ? "https://calendly.com/your-name/15min" : "https://cal.com/your-name/15min"}
                className="w-full bg-background border border-border/80 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none px-3.5 py-2.5 rounded-xl text-sm"
              />
              {bookingUrl.trim() && /^https?:\/\//i.test(bookingUrl.trim()) && (
                <a
                  href={bookingUrl.trim()}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2.5 rounded-xl border border-border/80 hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                  title="Open booking link"
                >
                  <ExternalLink className="size-4" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2.5 text-xs text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoMoveStage}
              onChange={(e) => setAutoMoveStage(e.target.checked)}
              className="rounded border-border accent-emerald-500"
            />
            Automatically move matching leads to &quot;Meeting Booked&quot; and notify me on booking
          </label>

          <button
            type="submit"
            disabled={saveBooking.isPending}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 self-start sm:self-auto cursor-pointer"
          >
            {saveBooking.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save Booking Link
          </button>
        </div>
      </form>

      {webhookUrl && (
        <div className="rounded-xl border border-border/70 bg-background/60 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              Auto-Sync Webhook URL ({provider === "calendly" ? "Calendly" : provider === "calcom" ? "Cal.com" : "Custom"})
            </span>
            <button
              type="button"
              onClick={handleCopyWebhook}
              className="px-2.5 py-1 rounded-lg border border-border/80 bg-card hover:bg-muted text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy URL"}
            </button>
          </div>
          <code className="block text-[11px] text-muted-foreground break-all bg-background border border-border/60 rounded-lg px-3 py-2">
            {webhookUrl}
          </code>
          <p className="text-[11px] text-muted-foreground">
            {provider === "calendly"
              ? "Paste this URL in Calendly → Integrations → Webhooks and enable the invitee.created event."
              : provider === "calcom"
                ? "Paste this URL in Cal.com → Settings → Developer → Webhooks and enable BOOKING_CREATED."
                : "POST JSON with attendee email (email or invitee.email) to auto-log bookings."}
          </p>
        </div>
      )}
    </div>
  );
}
