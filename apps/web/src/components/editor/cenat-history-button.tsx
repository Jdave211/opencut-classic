"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { getCenatPrimarySession, type CenatCheckpoint, type CenatVersion } from "@/lib/cenat-primary";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function CenatHistoryButton() {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [versions, setVersions] = useState<CenatVersion[]>([]);
	const [checkpoints, setCheckpoints] = useState<CenatCheckpoint[]>([]);
	const [checkpointName, setCheckpointName] = useState("");
	const [cursor, setCursor] = useState(-1);

	const showHistory = async () => {
		setOpen(true);
		setBusy(true);
		setError("");
		try {
			const session = getCenatPrimarySession();
			const project = editor.project.getActive();
			if (!session || !project) throw new Error("The project is still opening.");
			const history = await session.getHistory({ project });
			setVersions(history.versions);
			setCheckpoints(history.checkpoints);
			setCursor(history.cursor);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load project history.");
		} finally {
			setBusy(false);
		}
	};

	const saveCheckpoint = async () => {
		setBusy(true);
		setError("");
		try {
			const session = getCenatPrimarySession();
			const project = editor.project.getActive();
			if (!session || !project) throw new Error("The project is still opening.");
			await session.saveCheckpoint(checkpointName);
			const history = await session.getHistory({ project });
			setCheckpoints(history.checkpoints);
			setVersions(history.versions);
			setCursor(history.cursor);
			setCheckpointName("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save the checkpoint.");
		} finally {
			setBusy(false);
		}
	};

	const restore = async (index: number) => {
		setBusy(true);
		setError("");
		try {
			const session = getCenatPrimarySession();
			if (!session) throw new Error("The project is still opening.");
			await session.restoreVersion(index);
			window.location.reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not restore this version.");
			setBusy(false);
		}
	};
	const restoreCheckpoint = async (id: string) => {
		setBusy(true);
		setError("");
		try {
			const session = getCenatPrimarySession();
			if (!session) throw new Error("The project is still opening.");
			await session.restoreCheckpoint(id);
			window.location.reload();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not restore this checkpoint.");
			setBusy(false);
		}
	};

	return <>
		<button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium" onClick={() => void showHistory()}>History</button>
		<Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Project history</DialogTitle>
					<DialogDescription>Restore an earlier edit or keep a named checkpoint. Your current version stays in the history.</DialogDescription>
				</DialogHeader>
				<div className="max-h-80 space-y-1 overflow-y-auto px-6 pb-6">
					{busy && <p role="status" className="text-muted-foreground text-sm">Loading project history…</p>}
					{error && <p role="alert" className="text-destructive text-sm">{error}</p>}
					<div className="flex gap-2">
						<input aria-label="Checkpoint name" className="bg-background min-w-0 flex-1 rounded border px-3 py-2 text-sm" maxLength={100} placeholder="Name this checkpoint" value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} disabled={busy} />
						<button type="button" className="rounded border px-3 py-2 text-sm font-medium disabled:opacity-50" disabled={busy || !checkpointName.trim()} onClick={() => void saveCheckpoint()}>Save checkpoint</button>
					</div>
					{checkpoints.length > 0 && <><p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checkpoints</p>
						{checkpoints.slice().reverse().map((checkpoint) => <div key={checkpoint.id} className="flex items-center justify-between gap-3 rounded border p-3 text-sm">
							<div className="min-w-0"><p className="truncate font-medium">{checkpoint.name}</p><p className="text-muted-foreground text-xs">{new Date(checkpoint.date).toLocaleString()}</p></div>
							<button type="button" className="shrink-0 rounded border px-3 py-1.5 font-medium" disabled={busy} onClick={() => void restoreCheckpoint(checkpoint.id)}>Restore</button>
						</div>)}
					</>}
					<p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Versions</p>
					{!busy && versions.slice().reverse().map((version) => <div key={version.index} className="flex items-center justify-between gap-3 rounded border p-3 text-sm">
						<div className="min-w-0"><p className="truncate font-medium">{version.label}</p><p className="text-muted-foreground text-xs">{new Date(version.date).toLocaleString()}{version.index === cursor ? " · Current" : ""}</p></div>
						{version.index !== cursor && <button type="button" className="shrink-0 rounded border px-3 py-1.5 font-medium" onClick={() => void restore(version.index)}>Restore</button>}
					</div>)}
				</div>
			</DialogContent>
		</Dialog>
	</>;
}
