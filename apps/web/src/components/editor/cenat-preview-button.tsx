"use client";
/* eslint-disable jsx-a11y/media-has-caption -- Cenat burns project captions into its preview render. */

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { getCenatPrimarySession } from "@/lib/cenat-primary";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function CenatPreviewButton() {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	const render = async () => {
		const session = getCenatPrimarySession();
		if (!session || busy) return;
		setBusy(true);
		setProgress(0);
		setUrl("");
		setError("");
		try {
			const result = await session.preview({ project: editor.project.getActive(), persist: false, onProgress: setProgress });
			setUrl(result);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The preview could not be rendered.");
		} finally { setBusy(false); }
	};
	return <Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild><button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium" onClick={() => void render()}>
				Full preview
			</button></DialogTrigger>
			<DialogContent className="max-w-5xl overflow-hidden">
				<DialogHeader>
					<DialogTitle>Full preview</DialogTitle>
					<DialogDescription>Review the whole edit with transitions, text motion, masks, color, and audio.</DialogDescription>
				</DialogHeader>
				<div className="px-6 pb-6">
					{busy && <div role="status" className="bg-muted rounded p-6 text-sm">Rendering preview… {progress}%</div>}
					{error && <div role="alert" className="text-destructive rounded border p-4 text-sm">{error}</div>}
					{url && <video key={url} className="max-h-[70vh] w-full bg-black" controls autoPlay src={url} />}
					{(url || error) && <button type="button" className="mt-4 rounded border px-3 py-2 text-sm" onClick={() => void render()}>Render current edits again</button>}
				</div>
			</DialogContent>
		</Dialog>;
}
