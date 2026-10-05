"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import {
	buildDefaultParamValues,
	getBuiltInElementParams,
} from "@/params/registry";
import { storageService } from "@/services/storage/service";
import type { VideoElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time-rounding";

type ReportMedia = {
	id: string;
	bytes: number;
	durationSeconds: number;
	width: number;
	height: number;
};
type ReportClip = {
	sourceId: string;
	assetId: string;
	name: string;
	startTicks: number;
	inTicks: number;
	outTicks: number;
	durationTicks: number;
	sourceAudioEnabled: boolean;
};
type Report = {
	format: "cenat-to-opencut-compatibility-v1";
	sourceHash: string;
	projectName: string;
	status: "ready";
	fps: number;
	canvas: { width: number; height: number };
	media: ReportMedia[];
	clips: ReportClip[];
	totalDurationTicks: number;
	issues: {
		severity: string;
		code: string;
		location: string;
		detail: string;
	}[];
};

function isReadyReport(value: unknown): value is Report {
	if (!value || typeof value !== "object") return false;
	const report = value as Partial<Report>;
	return (
		report.format === "cenat-to-opencut-compatibility-v1" &&
		report.status === "ready" &&
		typeof report.sourceHash === "string" &&
		typeof report.projectName === "string" &&
		Number.isInteger(report.fps) &&
		Number.isInteger(report.totalDurationTicks) &&
		Number.isFinite(report.canvas?.width) &&
		Number.isFinite(report.canvas?.height) &&
		Array.isArray(report.media) &&
		Array.isArray(report.clips) &&
		Array.isArray(report.issues) &&
		!report.issues.some((item) => item.severity === "blocker")
	);
}

async function sha256(file: File): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function mediaMapping(
	report: Report,
	assets: MediaAsset[],
): Map<string, MediaAsset> {
	const mapping = new Map<string, MediaAsset>();
	for (const source of report.media) {
		const matches = assets.filter((asset) => asset.name === `${source.id}.mp4`);
		if (matches.length !== 1)
			throw new Error(
				`Expected one imported video for ${source.id}; found ${matches.length}.`,
			);
		const asset = matches[0];
		if (asset.type !== "video" || asset.file.size !== source.bytes)
			throw new Error(`Imported media does not match ${source.id}.`);
		if (
			asset.width !== source.width ||
			asset.height !== source.height ||
			Math.abs((asset.duration ?? 0) - source.durationSeconds) > 0.5
		) {
			throw new Error(
				`Imported video metadata differs from Cenat for ${source.id}.`,
			);
		}
		mapping.set(source.id, asset);
	}
	return mapping;
}

function buildProject(
	project: TProject,
	report: Report,
	mapping: Map<string, MediaAsset>,
): TProject {
	const scene = project.scenes.find((item) => item.isMain);
	if (!scene) throw new Error("The destination project has no main scene.");
	let expectedStart = 0;
	const seenIds = new Set<string>();
	const elements: VideoElement[] = report.clips.map((clip) => {
		const asset = mapping.get(clip.assetId);
		if (!asset || !clip.sourceId || seenIds.has(clip.sourceId))
			throw new Error(`Clip ${clip.sourceId} has no unique mapped media.`);
		seenIds.add(clip.sourceId);
		if (
			clip.startTicks !== expectedStart ||
			!Number.isInteger(clip.inTicks) ||
			!Number.isInteger(clip.outTicks) ||
			clip.inTicks < 0 ||
			clip.outTicks - clip.inTicks !== clip.durationTicks ||
			clip.durationTicks <= 0
		) {
			throw new Error(`Clip ${clip.sourceId} has invalid frame timing.`);
		}
		if (clip.outTicks > Math.round((asset.duration ?? 0) * 120_000) + 2_000)
			throw new Error(`Clip ${clip.sourceId} exceeds its source media.`);
		expectedStart += clip.durationTicks;
		const sourceDuration = Math.max(
			Math.round((asset.duration ?? 0) * 120_000),
			clip.outTicks,
		);
		return {
			id: clip.sourceId,
			type: "video",
			mediaId: asset.id,
			name: clip.name,
			startTime: clip.startTicks as MediaTime,
			duration: clip.durationTicks as MediaTime,
			trimStart: clip.inTicks as MediaTime,
			trimEnd: (sourceDuration - clip.outTicks) as MediaTime,
			sourceDuration: sourceDuration as MediaTime,
			isSourceAudioEnabled: clip.sourceAudioEnabled,
			hidden: false,
			params: buildDefaultParamValues(
				getBuiltInElementParams({ type: "video" }),
			),
		};
	});
	if (expectedStart !== report.totalDurationTicks)
		throw new Error("Report duration does not match its clips.");
	const updatedScene = {
		...scene,
		tracks: {
			...scene.tracks,
			main: { ...scene.tracks.main, elements },
			overlay: [],
			audio: [],
		},
		updatedAt: new Date(),
	};
	return {
		...project,
		metadata: {
			...project.metadata,
			name: report.projectName,
			duration: expectedStart as MediaTime,
			updatedAt: new Date(),
		},
		scenes: project.scenes.map((item) =>
			item.id === scene.id ? updatedScene : item,
		),
		settings: {
			...project.settings,
			fps: { numerator: report.fps, denominator: 1 },
			canvasSize: report.canvas,
			canvasSizeMode: "custom",
		},
	};
}

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
			setError((failure as Error).message);
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
			const next = buildProject(
				loaded.project,
				report,
				mediaMapping(report, assets),
			);
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
			setError((failure as Error).message);
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
