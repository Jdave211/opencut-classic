import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import type { VideoElement } from "@/timeline/types";
import { roundMediaTime } from "@/wasm/media-time-rounding";

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
	needsProxy?: boolean;
	cenatEdit?: { clip: Record<string, unknown>; sourceAssetId: string } | null;
};
export type Report = {
	format: "cenat-to-opencut-compatibility-v1";
	sourceHash: string;
	projectName: string;
	status: "ready";
	fps: number;
	aspect: string;
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

export function isReadyReport(value: unknown): value is Report {
	if (!value || typeof value !== "object") return false;
	const report = value as Partial<Report>;
	return (
		report.format === "cenat-to-opencut-compatibility-v1" &&
		report.status === "ready" &&
		typeof report.sourceHash === "string" &&
		typeof report.projectName === "string" &&
		Number.isInteger(report.fps) &&
		typeof report.aspect === "string" &&
		Number.isInteger(report.totalDurationTicks) &&
		Number.isFinite(report.canvas?.width) &&
		Number.isFinite(report.canvas?.height) &&
		Array.isArray(report.media) &&
		Array.isArray(report.clips) &&
		Array.isArray(report.issues) &&
		!report.issues.some((item) => item.severity === "blocker")
	);
}

export async function sha256(file: File): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function mediaMapping({ report, assets }: { report: Report; assets: MediaAsset[] }): Map<string, MediaAsset> {
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

export function buildProject({ project, report, mapping }: {
	project: TProject;
	report: Report;
	mapping: Map<string, MediaAsset>;
}): TProject {
	const scene = project.scenes.find((item) => item.isMain);
	if (!scene) throw new Error("The destination project has no main scene.");
	let expectedStart = 0;
	const seenIds = new Set<string>();
	const elements: VideoElement[] = report.clips.map((clip) => {
		const asset = mapping.get(clip.assetId);
		const sourceAsset = clip.cenatEdit ? mapping.get(clip.cenatEdit.sourceAssetId) : null;
		if (clip.cenatEdit && !sourceAsset)
			throw new Error(`Clip ${clip.sourceId} has no original Cenat media.`);
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
			...(clip.cenatEdit ? {
				cenatEdit: {
					clip: clip.cenatEdit.clip,
					sourceMediaId: sourceAsset!.id,
					proxyMediaId: asset.id,
					fps: report.fps,
					aspect: report.aspect,
				},
			} : {}),
			name: clip.name,
			startTime: roundMediaTime({ time: clip.startTicks }),
			duration: roundMediaTime({ time: clip.durationTicks }),
			trimStart: roundMediaTime({ time: clip.inTicks }),
			trimEnd: roundMediaTime({ time: sourceDuration - clip.outTicks }),
			sourceDuration: roundMediaTime({ time: sourceDuration }),
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
			duration: roundMediaTime({ time: expectedStart }),
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
