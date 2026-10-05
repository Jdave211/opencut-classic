import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TICKS_PER_SECOND = 120_000;
const SUPPORTED_FPS = new Set([24, 25, 30, 60, 120]);
const PROJECT_FIELDS = new Set([
	"id",
	"name",
	"aspect",
	"fps",
	"clips",
	"tracks",
]);
const CLIP_FIELDS = new Set([
	"id",
	"assetId",
	"in",
	"out",
	"speed",
	"volume",
	"brightness",
	"overlays",
	"transition",
	"filter",
	"label",
]);

function issue(issues, severity, code, location, detail) {
	issues.push({ severity, code, location, detail });
}

function frameTicks(seconds, fps) {
	return Math.round(seconds * fps) * (TICKS_PER_SECOND / fps);
}

function sourceProject(value) {
	if (value && Array.isArray(value.snapshots)) {
		const cursor = value.cursor;
		return value.snapshots[cursor]?.project;
	}
	return value;
}

/** @param {{ source: any, assets: any[], mediaRoot?: string | null, mediaSizes?: Map<string, number> | null, sourceHash: string }} input */
export function analyzeCenatProject({ source, assets, mediaRoot = null, mediaSizes = null, sourceHash }) {
	const issues = [];
	const project = sourceProject(source);
	const report = {
		format: "cenat-to-opencut-compatibility-v1",
		sourceHash,
		projectName: typeof project?.name === "string" ? project.name : null,
		status: "blocked",
		fps: null,
		canvas: null,
		clipCount: Array.isArray(project?.clips) ? project.clips.length : 0,
		media: [],
		clips: [],
		issues,
	};
	if (!project || typeof project !== "object" || Array.isArray(project)) {
		issue(
			issues,
			"blocker",
			"invalid-project",
			"project",
			"Expected a Cenat project object.",
		);
		return report;
	}
	for (const key of Object.keys(project)) {
		if (!PROJECT_FIELDS.has(key))
			issue(
				issues,
				"blocker",
				"unknown-project-field",
				`project.${key}`,
				"No verified mapping exists.",
			);
	}
	if (!report.projectName?.trim())
		issue(
			issues,
			"blocker",
			"missing-name",
			"project.name",
			"A project name is required.",
		);
	if (!Array.isArray(project.clips) || project.clips.length === 0) {
		issue(
			issues,
			"blocker",
			"missing-clips",
			"project.clips",
			"At least one clip is required for this first migration slice.",
		);
		return report;
	}
	if (
		project.tracks !== undefined &&
		(!Array.isArray(project.tracks) || project.tracks.length > 0)
	) {
		issue(
			issues,
			"blocker",
			"tracks-unmapped",
			"project.tracks",
			"Audio, overlay, and extra tracks need their own mapping.",
		);
	}
	const fps = project.fps ?? 30;
	if (project.fps === undefined)
		issue(
			issues,
			"warning",
			"default-fps",
			"project.fps",
			"Cenat's 30 fps fallback was used.",
		);
	if (!SUPPORTED_FPS.has(fps)) {
		issue(
			issues,
			"blocker",
			"unsupported-fps",
			"project.fps",
			"This slice supports 24, 25, 30, 60, and 120 fps.",
		);
	} else report.fps = fps;
	const assetIndex = new Map(
		Array.isArray(assets) ? assets.map((asset) => [asset.id, asset]) : [],
	);
	const checkedMedia = new Map();
	const checkedClipIds = new Set();
	let startTime = 0;
	for (const [index, clip] of project.clips.entries()) {
		const location = `project.clips[${index}]`;
		if (!clip || typeof clip !== "object" || Array.isArray(clip)) {
			issue(
				issues,
				"blocker",
				"invalid-clip",
				location,
				"Expected a clip object.",
			);
			continue;
		}
		for (const key of Object.keys(clip)) {
			if (!CLIP_FIELDS.has(key))
				issue(
					issues,
					"blocker",
					"unknown-clip-field",
					`${location}.${key}`,
					"No verified mapping exists.",
				);
		}
		if (clip.speed !== undefined && clip.speed !== 1)
			issue(
				issues,
				"blocker",
				"speed-unmapped",
				`${location}.speed`,
				"Retime needs preview and export parity.",
			);
		if (clip.brightness !== undefined && clip.brightness !== 1)
			issue(
				issues,
				"blocker",
				"grade-unmapped",
				`${location}.brightness`,
				"Color grade needs preview and export parity.",
			);
		if (clip.volume !== undefined && clip.volume !== 1 && clip.volume !== 0)
			issue(
				issues,
				"blocker",
				"volume-unmapped",
				`${location}.volume`,
				"Intermediate gain needs preview and export parity.",
			);
		if (clip.filter !== undefined && clip.filter !== "none")
			issue(
				issues,
				"blocker",
				"filter-unmapped",
				`${location}.filter`,
				"Filter needs preview and export parity.",
			);
		if (
			clip.overlays !== undefined &&
			(!Array.isArray(clip.overlays) || clip.overlays.length > 0)
		)
			issue(
				issues,
				"blocker",
				"overlay-unmapped",
				`${location}.overlays`,
				"Titles and overlays need their own mapping.",
			);
		if (clip.transition !== undefined && clip.transition?.type !== "none")
			issue(
				issues,
				"blocker",
				"transition-unmapped",
				`${location}.transition`,
				"Transition needs preview and export parity.",
			);
		if (typeof clip.id !== "string" || typeof clip.assetId !== "string")
			issue(
				issues,
				"blocker",
				"missing-clip-id",
				location,
				"Clip and asset IDs are required.",
			);
		if (typeof clip.id === "string") {
			if (checkedClipIds.has(clip.id))
				issue(
					issues,
					"blocker",
					"duplicate-clip-id",
					`${location}.id`,
					"Clip IDs must be unique.",
				);
			checkedClipIds.add(clip.id);
		}
		if (
			!Number.isFinite(clip.in) ||
			!Number.isFinite(clip.out) ||
			clip.in < 0 ||
			clip.out <= clip.in
		) {
			issue(
				issues,
				"blocker",
				"invalid-trim",
				location,
				"Clip in/out must be finite and ordered.",
			);
			continue;
		}
		const asset = assetIndex.get(clip.assetId);
		if (!asset) {
			issue(
				issues,
				"blocker",
				"missing-asset",
				`${location}.assetId`,
				"Asset metadata was not found.",
			);
			continue;
		}
		if (!checkedMedia.has(asset.id)) {
			if (asset.url !== `/uploads/${asset.id}.mp4`)
				issue(
					issues,
					"blocker",
					"unsupported-media-name",
					`assets.${asset.id}.url`,
					"This slice expects Cenat's processed MP4 named by asset ID.",
				);
			let mediaPath = null;
			let bytes = null;
			if (
				typeof asset.url === "string" &&
				/^\/uploads\/[A-Za-z0-9._-]+$/.test(asset.url) &&
				!asset.url.endsWith("/.") &&
				!asset.url.endsWith("/..")
			) {
					mediaPath = mediaRoot ? path.resolve(mediaRoot, asset.url.slice(1)) : asset.url;
					try {
						if (mediaSizes) {
							bytes = mediaSizes.get(asset.id);
							if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("invalid media size");
						} else {
							const stat = statSync(mediaPath);
							if (!stat.isFile()) throw new Error("not a file");
							bytes = stat.size;
						}
					} catch {
					issue(
						issues,
						"blocker",
						"missing-media",
						`assets.${asset.id}`,
						"The linked media file is absent.",
					);
				}
			} else
				issue(
					issues,
					"blocker",
					"unsafe-media-path",
					`assets.${asset.id}.url`,
					"Only local /uploads/ media paths are accepted.",
				);
			if (
				!Number.isFinite(asset.duration) ||
				asset.duration <= 0 ||
				!Number.isFinite(asset.width) ||
				!Number.isFinite(asset.height)
			) {
				issue(
					issues,
					"blocker",
					"invalid-asset-metadata",
					`assets.${asset.id}`,
					"Duration and dimensions are required.",
				);
			}
			const entry = {
				id: asset.id,
				name: asset.name,
				path: mediaPath,
				bytes,
				durationSeconds: asset.duration,
				width: asset.width,
				height: asset.height,
			};
			checkedMedia.set(asset.id, entry);
			report.media.push(entry);
		}
		if (Number.isFinite(asset.duration) && clip.out > asset.duration + 0.001)
			issue(
				issues,
				"blocker",
				"trim-outside-media",
				`${location}.out`,
				"Clip ends beyond linked media.",
			);
		if (report.fps) {
			const inTicks = frameTicks(clip.in, report.fps);
			const outTicks = frameTicks(clip.out, report.fps);
			const durationTicks = outTicks - inTicks;
			if (durationTicks <= 0)
				issue(
					issues,
					"blocker",
					"subframe-clip",
					location,
					"Clip is shorter than one output frame after rounding.",
				);
			const roundingSeconds = Math.max(
				Math.abs(inTicks / TICKS_PER_SECOND - clip.in),
				Math.abs(outTicks / TICKS_PER_SECOND - clip.out),
			);
			if (roundingSeconds > 0.000001)
				issue(
					issues,
					"warning",
					"frame-rounding",
					location,
					`Maximum boundary adjustment: ${roundingSeconds.toFixed(6)} seconds.`,
				);
			report.clips.push({
				sourceId: clip.id,
				assetId: clip.assetId,
				name: clip.label || asset.name,
				startTicks: startTime,
				inTicks,
				outTicks,
				durationTicks,
				sourceAudioEnabled: clip.volume !== 0,
			});
			startTime += durationTicks;
		}
	}
	if (project.aspect === "source") {
		const first = report.media[0];
		if (
			first &&
			report.media.every(
				(item) => item.width * first.height === item.height * first.width,
			)
		)
			report.canvas = { width: first.width, height: first.height };
		else
			issue(
				issues,
				"blocker",
				"mixed-source-aspect",
				"project.aspect",
				"Source aspect requires matching media ratios.",
			);
	} else if (project.aspect === "16:9")
		report.canvas = { width: 1920, height: 1080 };
	else if (project.aspect === "9:16")
		report.canvas = { width: 1080, height: 1920 };
	else
		issue(
			issues,
			"blocker",
			"unsupported-aspect",
			"project.aspect",
			"No verified canvas mapping exists.",
		);
	report.totalDurationTicks = startTime;
	report.status = issues.some((item) => item.severity === "blocker")
		? "blocked"
		: "ready";
	return report;
}

function cli() {
	const args = process.argv.slice(2);
	const option = (flag) => {
		const index = args.indexOf(flag);
		return index < 0 ? undefined : args[index + 1];
	};
	const projectPath = option("--project");
	const assetsPath = option("--assets");
	const mediaRoot = option("--media-root");
	const outPath = option("--out");
	if (!projectPath || !assetsPath || !mediaRoot || !outPath) {
		throw new Error(
			"Usage: bun scripts/cenat-compatibility.mjs --project <json> --assets <json> --media-root <directory> --out <report.json>",
		);
	}
	const sourceBytes = readFileSync(projectPath);
	const report = analyzeCenatProject({
		source: JSON.parse(sourceBytes),
		assets: JSON.parse(readFileSync(assetsPath, "utf8")),
		mediaRoot,
		sourceHash: createHash("sha256").update(sourceBytes).digest("hex"),
	});
	writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
	console.log(
		`${report.status}: ${report.projectName ?? "unknown project"}; ${report.clipCount} clips; ${report.media.length} media files; ${report.issues.filter((item) => item.severity === "blocker").length} blockers; report: ${outPath}`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
	cli();
