"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { getCenatPrimarySession } from "@/lib/cenat-primary";

export function CenatExportButton() {
	const editor = useEditor();
	const [resolution, setResolution] = useState<"720" | "1080" | "2160">("1080");
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	const exportProject = async () => {
		const session = getCenatPrimarySession();
		if (!session || busy) return;
		setBusy(true);
		setUrl("");
		setError("");
		setProgress(0);
		try {
			await editor.save.flush();
			if (editor.save.getIsDirty()) throw new Error("The project did not save. Try again before exporting.");
			const project = editor.project.getActive();
			const result = await session.export({ project, resolution, onProgress: setProgress });
			setUrl(result);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Export failed.");
		} finally { setBusy(false); }
	};
	return <div className="flex items-center gap-2">
		<select aria-label="Export resolution" className="bg-background rounded border px-2 py-1 text-xs" value={resolution} onChange={(event) => {
			const value = event.target.value;
			if (value === "720" || value === "1080" || value === "2160") setResolution(value);
		}}>
			<option value="720">720p</option><option value="1080">1080p</option><option value="2160">4K</option>
		</select>
		<button type="button" className="rounded-md bg-[#2567EC] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60" onClick={() => void exportProject()} disabled={busy}>{busy ? `Exporting ${progress}%` : "Export"}</button>
		{url && <a className="text-sm text-sky-400 underline" href={url} download>Download video</a>}
		{error && <span className="max-w-56 text-xs text-red-400" role="alert">{error}</span>}
	</div>;
}
