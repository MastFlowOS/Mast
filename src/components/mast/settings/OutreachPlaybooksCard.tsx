import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCreateOutreachPlaybook,
  useDeleteOutreachPlaybook,
  useMe,
  useOutreachPlaybooks,
  useUpdateOutreachPlaybook,
} from "@/hooks/use-mast-api";
import type { OutreachPlaybook } from "@/lib/api";
import { MastConfirm } from "@/components/mast/ui/MastConfirm";

export function OutreachPlaybooksCard() {
  const { data: auth } = useMe();
  const playbooksQuery = useOutreachPlaybooks(!!auth?.user);
  const createPlaybook = useCreateOutreachPlaybook();
  const updatePlaybook = useUpdateOutreachPlaybook();
  const deletePlaybook = useDeleteOutreachPlaybook();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [promptInstructions, setPromptInstructions] = useState("");
  const [exampleMessages, setExampleMessages] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  const playbooks = playbooksQuery.data?.playbooks ?? [];

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setPromptInstructions("");
    setExampleMessages("");
    setIsDefault(playbooks.length === 0);
    setComposerOpen(false);
  };

  const openNew = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setPromptInstructions("");
    setExampleMessages("");
    setIsDefault(playbooks.length === 0);
    setComposerOpen(true);
  };

  const openEdit = (pb: OutreachPlaybook) => {
    setEditingId(pb.id);
    setName(pb.name);
    setDescription(pb.description ?? "");
    setPromptInstructions(pb.promptInstructions);
    setExampleMessages(pb.exampleMessages ?? "");
    setIsDefault(pb.isDefault);
    setComposerOpen(true);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 100_000) {
      toast.error("Prompt file is too large (max 100 KB).");
      return;
    }
    try {
      const text = (await file.text()).trim();
      if (!text) {
        toast.error("That file is empty.");
        return;
      }
      setPromptInstructions(text.slice(0, 4000));
      if (!name.trim()) {
        setName(file.name.replace(/\.(txt|md|markdown)$/i, "").slice(0, 80));
      }
      setComposerOpen(true);
      toast.success(`Loaded "${file.name}" into your playbook`);
    } catch {
      toast.error("Could not read that file.");
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanPrompt = promptInstructions.trim();
    if (!cleanName) {
      toast.error("Give your playbook a name.");
      return;
    }
    if (cleanPrompt.length < 10) {
      toast.error("Write at least a short instruction (10+ characters) for how the AI should sound.");
      return;
    }

    try {
      if (editingId) {
        await updatePlaybook.mutateAsync({
          id: editingId,
          name: cleanName,
          description: description.trim() || null,
          promptInstructions: cleanPrompt,
          exampleMessages: exampleMessages.trim() || null,
          isDefault,
        });
        toast.success("Outreach playbook updated");
      } else {
        await createPlaybook.mutateAsync({
          name: cleanName,
          description: description.trim() || null,
          promptInstructions: cleanPrompt,
          exampleMessages: exampleMessages.trim() || null,
          isDefault,
        });
        toast.success("Outreach playbook saved");
      }
      resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save playbook");
    }
  };

  const handleSetDefault = async (pb: OutreachPlaybook) => {
    try {
      await updatePlaybook.mutateAsync({ id: pb.id, isDefault: !pb.isDefault });
      toast.success(pb.isDefault ? `"${pb.name}" is no longer the default` : `"${pb.name}" set as default voice`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update default playbook");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deletePlaybook.mutateAsync(id);
      if (editingId === id) resetForm();
      toast.success("Playbook removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete playbook");
    }
  };

  const isSaving = createPlaybook.isPending || updatePlaybook.isPending;

  return (
    <div className="bg-card border border-border/60 rounded-2xl p-6 shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="size-10 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400 grid place-items-center shrink-0">
            <Sparkles className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">AI Outreach Playbooks &amp; Custom Voice</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload your own outreach skill, prompt, or message examples so AI messages sound like you — not a template.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-xl border border-border/80 bg-background hover:bg-muted text-xs font-medium text-foreground inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Upload className="size-3.5" />
            Upload .txt / .md
          </button>
          <button
            type="button"
            onClick={openNew}
            className="px-3 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="size-3.5" />
            New Playbook
          </button>
        </div>
      </div>

      {composerOpen && (
        <form
          onSubmit={handleSave}
          className="rounded-xl border border-violet-500/25 bg-violet-500/[0.04] p-4 space-y-3.5"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">
              {editingId ? "Edit Outreach Playbook" : "Create New Outreach Playbook"}
            </p>
            <button
              type="button"
              onClick={resetForm}
              className="text-muted-foreground hover:text-foreground p-1 rounded-lg cursor-pointer"
              aria-label="Close playbook editor"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Playbook Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Casual Founder DM, Direct Redesign Pitch"
                className="w-full bg-background border border-border/80 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none px-3 py-2 rounded-xl text-sm"
                maxLength={120}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1">
                Short Note (optional)
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When to use this style"
                className="w-full bg-background border border-border/80 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none px-3 py-2 rounded-xl text-sm"
                maxLength={300}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-semibold text-muted-foreground">
                Prompt / Skill Instructions
              </label>
              <span className="text-[11px] text-muted-foreground">
                {promptInstructions.length} / 4000
              </span>
            </div>
            <textarea
              rows={5}
              value={promptInstructions}
              onChange={(e) => setPromptInstructions(e.target.value)}
              placeholder="Write how you want the AI to talk, your hook style, your CTA, words to avoid, or paste a full custom skill prompt..."
              className="w-full bg-background border border-border/80 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none px-3 py-2.5 rounded-xl text-sm resize-y"
              maxLength={4000}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1">
              Example Messages You&apos;ve Sent (optional)
            </label>
            <textarea
              rows={3}
              value={exampleMessages}
              onChange={(e) => setExampleMessages(e.target.value)}
              placeholder="Paste 1-2 real outreach messages you wrote so the AI matches your exact rhythm and tone."
              className="w-full bg-background border border-border/80 focus:border-violet-500 focus:ring-1 focus:ring-violet-500 outline-none px-3 py-2.5 rounded-xl text-sm resize-y"
              maxLength={4000}
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
            <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="rounded border-border accent-violet-500"
              />
              Use as my default AI voice in the Lead Workspace
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="px-3 py-1.5 rounded-xl border border-border/80 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {editingId ? "Save Changes" : "Save Playbook"}
              </button>
            </div>
          </div>
        </form>
      )}

      {playbooksQuery.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="size-3.5 animate-spin" />
          Loading your outreach playbooks...
        </div>
      ) : playbooks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/80 bg-background/40 p-4 text-xs text-muted-foreground flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <span>
            No custom playbooks yet. Add one (or upload a <code className="text-foreground">.txt</code> /{" "}
            <code className="text-foreground">.md</code> prompt) to test different angles and make AI messages feel like you.
          </span>
          <button
            type="button"
            onClick={openNew}
            className="text-violet-400 hover:text-violet-300 font-semibold shrink-0 cursor-pointer"
          >
            Create your first playbook →
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {playbooks.map((pb) => (
            <div
              key={pb.id}
              className="rounded-xl border border-border/70 bg-background/60 p-3.5 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">{pb.name}</span>
                  {pb.isDefault && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-500/15 text-violet-300 border border-violet-500/30">
                      <Star className="size-2.5 fill-current" />
                      Default
                    </span>
                  )}
                </div>
                {pb.description && (
                  <p className="text-xs text-muted-foreground">{pb.description}</p>
                )}
                <p className="text-xs text-muted-foreground/90 line-clamp-2 whitespace-pre-wrap">
                  {pb.promptInstructions}
                </p>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleSetDefault(pb)}
                  disabled={updatePlaybook.isPending}
                  title={pb.isDefault ? "Unset default" : "Set as default voice"}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                    pb.isDefault
                      ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                      : "border-border/70 hover:bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {pb.isDefault ? "Default" : "Set Default"}
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(pb)}
                  className="p-1.5 rounded-lg border border-border/70 hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Edit playbook"
                >
                  <Pencil className="size-3.5" />
                </button>
                <MastConfirm
                  trigger={
                    <button
                      type="button"
                      className="p-1.5 rounded-lg border border-border/70 hover:bg-destructive/10 text-muted-foreground hover:text-destructive cursor-pointer"
                      title="Delete playbook"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  }
                  title={`Delete "${pb.name}"?`}
                  description="This removes the custom playbook from your workspace. Existing drafts aren't affected."
                  confirmText="Delete"
                  variant="destructive"
                  onConfirm={() => handleDelete(pb.id)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
