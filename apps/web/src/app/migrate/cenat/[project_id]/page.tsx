"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { storageService } from "@/services/storage/service";
import { buildProject, isReadyReport, mediaMapping, sha256, type Report } from "@/lib/cenat-import";

export default function CenatMigrationPage() {
	const params = useParams<{ project_id: string }>();
	const projectId = params.project_id;
	const [sourceFile, setSourceFile] = useState<File | null>(null);
	const [report, setReport] = useState<Report | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);

	async function loadReport(file: File | undefined) {
		setReport(null);
		setError("");
		if (!file) return;
		try {
			const value: unknown = JSON.parse(await file.text());
			if (!isReadyReport(value))
				throw new Error(
					"This report has blockers or is not a valid ready report.",
				);
			setReport(value);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not read the report.");
		}
	}

	async function apply() {
		if (!report || !sourceFile || busy) return;
		setBusy(true);
		setError("");
		try {
			if ((await sha256(sourceFile)) !== report.sourceHash)
				throw new Error(
					"The Cenat project file differs from the preflight report.",
				);
			const loaded = await storageService.loadProject({ id: projectId });
			if (!loaded) throw new Error("Destination project was not found.");
			if (loaded.project.scenes.some((scene) =>
				scene.tracks.main.elements.length > 0 ||
				scene.tracks.overlay.some((track) => track.elements.length > 0) ||
				scene.tracks.audio.some((track) => track.elements.length > 0),
			)) throw new Error("Destination timeline is not empty. Create a blank project for this import.");
			const assets = await storageService.loadAllMediaAssets({ projectId });
			const next = buildProject({
				project: loaded.project,
				report,
				mapping: mediaMapping({ report, assets }),
			});
			await storageService.saveProject({ project: next });
			const saved = await storageService.loadProject({ id: projectId });
			const savedClips =
				saved?.project.scenes.find((scene) => scene.isMain)?.tracks.main
					.elements ?? [];
			if (
				saved?.project.metadata.duration !== report.totalDurationTicks ||
				savedClips.length !== report.clips.length ||
				savedClips.some(
					(clip, index) =>
						clip.startTime !== report.clips[index].startTicks ||
						clip.duration !== report.clips[index].durationTicks,
				)
			) {
				await storageService.saveProject({ project: loaded.project });
				throw new Error(
					"Saved timeline verification failed; the destination project was restored.",
				);
			}
			setDone(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not import the timeline.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="mx-auto max-w-2xl px-6 py-12 text-foreground">
			<a
				href={`/editor/${projectId}`}
				className="text-sm underline underline-offset-4"
			>
				Back to editor
			</a>
			<h1 className="mt-10 text-3xl font-semibold">Import a Cenat timeline</h1>
			<p className="mt-3 text-muted-foreground">
				Choose the original Cenat project JSON and its compatibility report.
				Both are checked in this browser before the destination timeline is
				replaced.
			</p>
			<div className="mt-8 space-y-5">
				<label className="block text-sm font-medium">
					Cenat project JSON
					<input
						className="mt-2 block w-full"
						type="file"
						accept=".json,application/json"
						onChange={(event) => {
							setSourceFile(event.target.files?.[0] ?? null);
							setDone(false);
						}}
					/>
				</label>
				<label className="block text-sm font-medium">
					Compatibility report
					<input
						className="mt-2 block w-full"
						type="file"
						accept=".json,application/json"
						onChange={(event) => {
							void loadReport(event.target.files?.[0]);
							setDone(false);
						}}
					/>
				</label>
			</div>
			{report && (
				<section
					className="mt-8 rounded-xl border p-5"
					aria-label="Compatibility summary"
				>
					<h2 className="text-lg font-semibold">{report.projectName}</h2>
					<p className="mt-1 text-sm">
						Ready: {report.clips.length} clips, {report.media.length} linked
						media files, {report.fps} fps.
					</p>
					{report.issues.length > 0 && (
						<ul className="mt-3 list-disc pl-5 text-sm text-muted-foreground">
							{report.issues.map((item, index) => (
								<li key={`${item.code}-${index}`}>
									{item.location}: {item.detail}
								</li>
							))}
						</ul>
					)}
				</section>
			)}
			{error && (
				<p className="mt-5 text-sm text-destructive" role="alert">
					{error}
				</p>
			)}
			{done ? (
				<p className="mt-6" role="status">
					Timeline saved and verified.{" "}
					<a
						className="underline underline-offset-4"
						href={`/editor/${projectId}`}
					>
						Open migrated editor
					</a>
				</p>
			) : (
				<button
					className="mt-6 rounded-lg bg-primary px-5 py-3 text-primary-foreground disabled:opacity-50"
					disabled={!report || !sourceFile || busy}
					onClick={() => void apply()}
				>
					{busy ? "Checking and importing…" : "Import into this project"}
				</button>
			)}
		</main>
	);
}
