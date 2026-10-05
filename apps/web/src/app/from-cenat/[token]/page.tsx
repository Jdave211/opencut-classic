"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useEditor } from "@/editor/use-editor";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildProject, isReadyReport, mediaMapping, type Report } from "@/lib/cenat-import";
import { CENAT_API_ORIGIN, copyLocalVideo, renderCenatClip } from "@/lib/cenat-proxy";
import { storageService } from "@/services/storage/service";

type Handoff = {
	projectId: string;
	source: string;
	assets: { id: string; url: string; bytes: number }[];
	expiresAt: number;
};
type Finding = { severity: string; code: string; location: string; detail: string };
type Preflight = Partial<Omit<Report, "status">> & { status?: string; issues?: Finding[]; projectName?: string };
type RenderableReport = Preflight & { sourceHash: string; projectName: string };

const CENAT_ORIGIN = "http://localhost:5173";
const MAP_KEY = "cenat.importedProjects.v1";
const RENDERABLE_BLOCKERS = new Set(["filter-unmapped", "overlay-unmapped", "grade-unmapped"]);
function canOpenRenderedCopy(report: Preflight): report is RenderableReport {
	return report.format === "cenat-to-opencut-compatibility-v1" &&
		typeof report.sourceHash === "string" &&
		typeof report.projectName === "string" && report.projectName.length > 0;
}

async function saveTimeline({ editor, report, files, key }: {
	editor: EditorCore;
	report: Report;
	files: File[];
	key: string;
}): Promise<string> {
	let createdId: string | null = null;
	try {
		const processed = await processMediaAssets({ files });
		if (processed.length !== report.media.length)
			throw new Error("Media processing did not complete for every source file.");
		await editor.project.loadAllProjects();
		createdId = await editor.project.createNewProject({ name: report.projectName });
		for (const asset of processed) {
			const saved = await editor.media.addMediaAsset({ projectId: createdId, asset });
			if (!saved) throw new Error(`Could not save ${asset.name} in browser storage.`);
		}
		const blank = await storageService.loadProject({ id: createdId });
		if (!blank) throw new Error("New project storage is unavailable.");
		const savedAssets = await storageService.loadAllMediaAssets({ projectId: createdId });
		const next = buildProject({ project: blank.project, report, mapping: mediaMapping({ report, assets: savedAssets }) });
		await storageService.saveProject({ project: next });
		const verified = await storageService.loadProject({ id: createdId });
		const elements = verified?.project.scenes.find((scene) => scene.isMain)?.tracks.main.elements ?? [];
		if (verified?.project.metadata.duration !== report.totalDurationTicks ||
			elements.length !== report.clips.length ||
			elements.some((item, index) => item.startTime !== report.clips[index].startTicks || item.duration !== report.clips[index].durationTicks))
			throw new Error("The new timeline did not verify after saving.");
		const imported: Record<string, string> = JSON.parse(localStorage.getItem(MAP_KEY) || "{}");
		localStorage.setItem(MAP_KEY, JSON.stringify({ ...imported, [key]: createdId }));
		return createdId;
	} catch (error) {
		if (createdId) await Promise.allSettled([
			storageService.deleteProject({ id: createdId }),
			storageService.deleteProjectMedia({ projectId: createdId }),
		]);
		throw error;
	}
}

export default function FromCenatPage() {
	const { token } = useParams<{ token: string }>();
	const router = useRouter();
	const editor = useEditor();
	const started = useRef(false);
	const [progress, setProgress] = useState("Checking the saved project…");
	const [error, setError] = useState("");
	const [report, setReport] = useState<Preflight | null>(null);
	const [sourceProjectId, setSourceProjectId] = useState("");
	const [rendering, setRendering] = useState(false);
	const [handoff, setHandoff] = useState<Handoff | null>(null);

	const openRenderedCopy = useCallback(async ({ source, checked }: { source: Handoff; checked: Preflight }) => {
		if (!canOpenRenderedCopy(checked) || rendering) return;
		setRendering(true);
		setError("");
		let currentStep = "Preparing the render";
		try {
			const key = `${source.projectId}:${checked.sourceHash}:rendered`;
			const imported: Record<string, string> = JSON.parse(localStorage.getItem(MAP_KEY) || "{}");
			if (imported[key] && await storageService.loadProject({ id: imported[key] })) {
				router.replace(`/editor/${imported[key]}`);
				return;
			}
			setProgress("Rendering the Cenat edits into a video copy…");
			currentStep = "Starting the render";
			const started = await fetch(`${CENAT_API_ORIGIN}/api/classic/handoffs/${encodeURIComponent(token)}/render`, { method: "POST" });
			let job: { id: string; status: string; progress?: number; error?: string; url?: string; duration?: number; width?: number; height?: number } = await started.json();
			if (!started.ok) throw new Error(job.error || "Cenat could not start the render.");
			while (job.status !== "complete") {
				if (job.status === "failed") throw new Error(job.error || "The render failed.");
				setProgress(`Rendering the Cenat edits… ${job.progress ?? 0}%`);
				currentStep = "Checking render progress";
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const response = await fetch(`${CENAT_API_ORIGIN}/api/export/${encodeURIComponent(job.id)}`);
				if (!response.ok) throw new Error("The render status could not be read.");
				job = await response.json();
			}
			if (!job.url?.startsWith("/exports/") || !Number.isFinite(job.duration) || !Number.isFinite(job.width) || !Number.isFinite(job.height))
				throw new Error("The completed render is missing its video metadata.");
			setProgress("Copying the rendered video into the new editor…");
			currentStep = "Copying the rendered video";
			const blob = await copyLocalVideo({ url: `${CENAT_API_ORIGIN}${job.url}` });
			const fps = Number.isInteger(checked.fps) ? checked.fps! : 30;
			const durationTicks = Math.round(job.duration! * fps) * (120_000 / fps);
			const blockers = checked.issues?.filter((item) => item.severity === "blocker") ?? [];
			const preserveCuts = Array.isArray(checked.clips) && checked.clips.length > 0 &&
				Number.isInteger(checked.totalDurationTicks) &&
				Math.abs(checked.totalDurationTicks! - durationTicks) <= 120_000 / fps &&
				blockers.every((item) => RENDERABLE_BLOCKERS.has(item.code));
			const baked: Report = {
				format: "cenat-to-opencut-compatibility-v1",
				sourceHash: checked.sourceHash,
				status: "ready",
				projectName: `${checked.projectName} (rendered copy)`,
				fps,
				aspect: checked.aspect ?? "source",
				canvas: { width: job.width!, height: job.height! },
				media: [{ id: "baked", bytes: blob.size, durationSeconds: job.duration!, width: job.width!, height: job.height! }],
				clips: preserveCuts ? checked.clips!.map((clip) => ({
					...clip,
					cenatEdit: null,
					needsProxy: false,
					assetId: "baked",
					inTicks: clip.startTicks,
					outTicks: clip.startTicks + clip.durationTicks,
				})) : [{
					sourceId: `rendered-${source.projectId}`,
					assetId: "baked",
					name: `${checked.projectName} render`,
					startTicks: 0,
					inTicks: 0,
					outTicks: durationTicks,
					durationTicks,
					sourceAudioEnabled: true,
				}],
				totalDurationTicks: preserveCuts ? checked.totalDurationTicks! : durationTicks,
				issues: [],
			};
			currentStep = "Saving the rendered timeline";
			const destination = await saveTimeline({ editor, report: baked, files: [new File([blob], "baked.mp4", { type: "video/mp4" })], key });
			router.replace(`/editor/${destination}`);
		} catch (failure) {
			setError(`${currentStep}: ${failure instanceof Error ? failure.message : "Could not open the rendered copy."}`);
			setProgress("");
		} finally {
			setRendering(false);
		}
	}, [editor, rendering, router, token]);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const returnTo = new URLSearchParams(window.location.search).get("returnTo");
		if (returnTo) {
			try {
				const url = new URL(returnTo);
				if (url.origin === CENAT_ORIGIN)
					sessionStorage.setItem("cenat.returnTo", url.origin);
			} catch { /* Ignore an invalid return address. */ }
		}
		void (async () => {
				try {
					const handoffResponse = await fetch(`${CENAT_API_ORIGIN}/api/classic/handoffs/${encodeURIComponent(token)}`);
				const handoff: Handoff = await handoffResponse.json();
				if (!handoffResponse.ok || typeof handoff.source !== "string" || !Array.isArray(handoff.assets))
					throw new Error("The Cenat handoff expired. Open this project again from Cenat.");
					setSourceProjectId(handoff.projectId);
					setHandoff(handoff);
				const preflightResponse = await fetch("/api/cenat/preflight", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ source: handoff.source, assets: handoff.assets }),
				});
				const checked: Preflight = await preflightResponse.json();
				if (!preflightResponse.ok) throw new Error("Compatibility review could not finish.");
					setReport(checked);
					if (!isReadyReport(checked)) {
						if (canOpenRenderedCopy(checked)) void openRenderedCopy({ source: handoff, checked });
						else setProgress("");
						return;
				}
				const key = `${handoff.projectId}:${checked.sourceHash}`;
				const imported: Record<string, string> = JSON.parse(localStorage.getItem(MAP_KEY) || "{}");
				if (imported[key]) {
					const existing = await storageService.loadProject({ id: imported[key] });
					if (existing) {
						router.replace(`/editor/${imported[key]}`);
						return;
					}
				}
				setProgress("Copying source media…");
				const files: File[] = [];
				for (const media of checked.media) {
					const asset = handoff.assets.find((item) => item.id === media.id);
					if (!asset || asset.url !== `/uploads/${media.id}.mp4`)
						throw new Error(`Source media ${media.id} no longer matches the report.`);
						const blob = await copyLocalVideo({ url: `${CENAT_API_ORIGIN}${asset.url}`, knownBytes: media.bytes });
					if (blob.size !== media.bytes) throw new Error(`Source media ${media.id} changed during import.`);
					files.push(new File([blob], `${media.id}.mp4`, { type: "video/mp4" }));
				}
					setProgress("Building and checking the new timeline…");
					const editable: Report = {
						...checked,
						media: [...checked.media],
						clips: checked.clips.map((clip) => ({ ...clip })),
					};
					for (const [index, clip] of editable.clips.entries()) {
						if (!clip.needsProxy || !clip.cenatEdit) continue;
						setProgress(`Preparing editable Cenat edits ${index + 1} of ${editable.clips.length}…`);
						const rendered = await renderCenatClip({
							clip: clip.cenatEdit.clip,
							fps: editable.fps,
							aspect: editable.aspect,
							onProgress: (value) => setProgress(`Rendering edit ${index + 1} of ${editable.clips.length}… ${value}%`),
						});
						if (Math.abs(rendered.duration * 120_000 - clip.durationTicks) > 120_000 / editable.fps)
							throw new Error(`Rendered clip ${clip.name} has a different duration from the source edit.`);
						const proxyId = `proxy-${clip.sourceId}`;
						editable.media.push({ id: proxyId, bytes: rendered.blob.size, durationSeconds: rendered.duration, width: rendered.width, height: rendered.height });
						files.push(new File([rendered.blob], `${proxyId}.mp4`, { type: "video/mp4" }));
						clip.assetId = proxyId;
						clip.inTicks = 0;
						clip.outTicks = clip.durationTicks;
					}
					const destination = await saveTimeline({ editor, report: editable, files, key });
					router.replace(`/editor/${destination}`);
				} catch (failure) {
				setError(failure instanceof Error ? failure.message : "Could not open the project.");
				setProgress("");
			}
		})();
	}, [editor, openRenderedCopy, router, token]);

	const blockers = report?.issues?.filter((item) => item.severity === "blocker") ?? [];
	return <main className="bg-background text-foreground min-h-screen px-6 py-14">
		<div className="mx-auto max-w-2xl">
			<a className="text-sm underline" href={CENAT_ORIGIN}>← Cenat projects</a>
			<h1 className="mt-10 text-3xl font-semibold">{report?.projectName || "Opening project"}</h1>
			{progress && <p className="mt-4 text-muted-foreground" role="status">{progress}</p>}
			{error && <p className="mt-4 text-destructive" role="alert">{error}</p>}
				{blockers.length > 0 && <>
				<p className="mt-4 text-muted-foreground">This project uses edits the new editor cannot yet change individually. A rendered copy keeps their appearance and sound. Its cuts remain separate where timing is compatible; otherwise it opens as one video. The original remains in Cenat.</p>
				<section className="mt-6 rounded-xl border p-5" aria-label="Compatibility report">
					<h2 className="font-semibold">Compatibility report</h2>
					<ul className="mt-3 list-disc space-y-2 pl-5 text-sm">{blockers.map((item, index) =>
						<li key={`${item.code}-${index}`}>{item.location}: {item.detail}</li>)}</ul>
				</section>
				{handoff && report && canOpenRenderedCopy(report) && !rendering && error &&
					<button className="mt-6 mr-3 rounded-lg bg-primary px-5 py-3 text-primary-foreground" onClick={() => void openRenderedCopy({ source: handoff, checked: report })}>Retry rendered copy</button>}
				{sourceProjectId && <a className="mt-6 inline-block rounded-lg border px-5 py-3" href={`${CENAT_ORIGIN}/?legacyProject=${encodeURIComponent(sourceProjectId)}`}>Continue in current editor</a>}
			</>}
		</div>
	</main>;
}
