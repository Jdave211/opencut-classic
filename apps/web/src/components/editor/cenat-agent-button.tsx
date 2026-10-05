"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { getCenatPrimarySession, type CenatConversationMessage } from "@/lib/cenat-primary";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Launch = { message: string; requestId?: string; model?: string; assetIds?: string[] };

export function CenatAgentButton() {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [messages, setMessages] = useState<CenatConversationMessage[]>([]);
	const [scope, setScope] = useState<"all" | "selected">("all");
	const running = useRef(false);
	const selected = useEditor((current) => current.selection.getSelectedElements());
	const activeProject = useEditor((current) => current.project.getActive());
	const selectedId = selected.length === 1 ? selected[0]?.elementId : undefined;
	const selectedClip = activeProject?.scenes.find((scene) => scene.isMain)?.tracks.main.elements.find((element) => element.id === selectedId);
	const showConversation = async () => {
		setOpen(true);
		try {
			const session = getCenatPrimarySession();
			if (session) setMessages(await session.getConversation());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load Jev's conversation.");
		}
	};

	const submit = async ({ message, launch }: { message: string; launch?: Launch }) => {
		const session = getCenatPrimarySession();
		const text = message.trim();
		if (!session || !text || running.current) return;
		running.current = true;
		setBusy(true);
		setError("");
		try {
			const clipId = !launch && scope === "selected" && selectedClip ? selectedClip.id : undefined;
			const result = await session.askJev({
				project: editor.project.getActive(), prompt: text,
				selectedId: clipId, scope: clipId ? "selected" : "all",
				launch,
			});
			if (result.changed) window.location.reload();
			else setMessages(await session.getConversation());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Jev could not finish this edit.");
		} finally {
			running.current = false;
			setBusy(false);
		}
	};

	useEffect(() => {
		const launch = getCenatPrimarySession()?.takeLaunch();
		if (!launch) return;
		queueMicrotask(() => {
			setPrompt(launch.message);
			setOpen(true);
			void submit({ message: launch.message, launch });
		});
	// A launch is consumed once per editor mount; the session prevents a second run.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return <>
		<button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium" onClick={() => void showConversation()}>Jev</button>
		<Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Ask Jev to edit</DialogTitle>
					<DialogDescription>Describe the change. Your current timeline is saved before Jev applies it.</DialogDescription>
				</DialogHeader>
				<form className="space-y-3 px-6 pb-6" onSubmit={(event) => { event.preventDefault(); void submit({ message: prompt }); }}>
				{messages.length > 0 && <div aria-label="Jev conversation" className="max-h-52 space-y-2 overflow-y-auto rounded border p-3 text-sm">
					{messages.map((item, index) => <div key={item.id || index} className={item.role === "user" ? "text-foreground" : "text-muted-foreground"}>
						<span className="font-semibold">{item.role === "user" ? "You" : "Jev"}</span><p className="whitespace-pre-wrap">{item.text}</p>
					</div>)}
				</div>}
				{selectedClip && <label className="text-muted-foreground flex items-center gap-2 text-sm">Apply to
					<select aria-label="Edit scope" className="bg-background rounded border px-2 py-1 text-foreground" value={scope} onChange={(event) => setScope(event.target.value === "selected" ? "selected" : "all")} disabled={busy}>
						<option value="all">Entire project</option><option value="selected">Selected clip · {selectedClip.name}</option>
					</select>
				</label>}
					<textarea aria-label="Describe an edit" className="bg-background min-h-28 w-full resize-y rounded border p-3 text-sm"
						maxLength={4000} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy} />
					{busy && <p role="status" className="text-muted-foreground text-sm">Jev is editing this project…</p>}
					{error && <p role="alert" className="text-destructive text-sm">{error}</p>}
					<button type="submit" className="bg-primary text-primary-foreground rounded px-4 py-2 text-sm disabled:opacity-50"
						disabled={busy || !prompt.trim()}>{busy ? "Editing…" : "Apply edit"}</button>
				</form>
			</DialogContent>
		</Dialog>
	</>;
}
