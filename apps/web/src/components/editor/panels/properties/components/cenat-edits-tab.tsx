"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { CENAT_API_ORIGIN, renderCenatClip, renderCenatStill } from "@/lib/cenat-proxy";
import type { ImageElement, VideoElement } from "@/timeline/types";
import { roundMediaTime } from "@/wasm/media-time-rounding";
import { getCenatPrimarySession } from "@/lib/cenat-primary";
import type { MediaAsset } from "@/media/types";

type CenatOverlay = Record<string, unknown> & { id: string; kind: string; text?: string };
type TimedWord = { text: string; start: number; end: number };
const FILTERS = ["none", "cinematic", "warm", "cool", "noir", "vintage", "vivid"];
const EFFECTS = ["none", "vignette", "blur", "rgb-split", "glitch", "film-grain", "vhs", "shake", "zoom-pulse", "zoom-punch", "flash", "echo", "glow", "pixelate", "mirror", "sharpen", "letterbox", "invert"];
const ANIMATIONS = ["none", "zoom-in", "zoom-out", "pan-left", "pan-right", "fade-in"];
const TEXT_ANIMATIONS = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "typewriter", "word-pop", "bounce", "pop", "blur-in", "karaoke", "spotlight-word", "zoom-blur", "rise", "word-slide", "glitch", "split-in", "appear", "drop-in", "stamp", "shimmer"];
const TITLE_TEMPLATES = ["none", "title", "chapter", "editorial", "locator", "kinetic", "arc", "stacked"];
const STICKERS = ["star", "heart", "arrow", "sparkle", "circle"];
const GRAPHICS = ["arrow", "curve", "loop", "line", "disc", "badge"];
const FLOAT_STYLES = ["none", "drift-up", "drift-left", "drift-right", "sway", "float", "breathe"];
const TEXT_STYLES = ["none", "shadow", "outline", "sticker", "glow", "gradient", "highlight", "underline", "strike", "circle", "3d-shadow"];
type CatalogEntry = { id: string; label: string; duration?: { min: number; max: number; default: number }; defaultAmount?: number };
type Catalog = { transitions: (CatalogEntry & { overlap?: boolean })[]; effects: CatalogEntry[]; textMotion: CatalogEntry[]; textStyles: CatalogEntry[] };
const GRADE_CONTROLS = [
	{ key: "brightness", label: "Brightness", defaultValue: 1, step: 0.05 },
	{ key: "contrast", label: "Contrast", defaultValue: 1, step: 0.05 },
	{ key: "saturation", label: "Saturation", defaultValue: 1, step: 0.05 },
	{ key: "temperature", label: "Temperature", defaultValue: 0, step: 0.05 },
	{ key: "tint", label: "Tint", defaultValue: 0, step: 0.05 },
	{ key: "shadows", label: "Shadows", defaultValue: 0, step: 0.05 },
	{ key: "highlights", label: "Highlights", defaultValue: 0, step: 0.05 },
	{ key: "hue", label: "Hue", defaultValue: 0, step: 1 },
	{ key: "clarity", label: "Clarity", defaultValue: 0, step: 0.05 },
	{ key: "vignette", label: "Vignette", defaultValue: 0, step: 0.05 },
	{ key: "glow", label: "Glow", defaultValue: 0, step: 0.05 },
	{ key: "lensBlur", label: "Lens blur", defaultValue: 0, step: 0.05 },
] as const;
const ADVANCED_GRADE_CONTROLS = [
	{ key: "subjectExposure", label: "Subject exposure", defaultValue: 0, min: -3, max: 3 },
	{ key: "subjectWarmth", label: "Subject warmth", defaultValue: 0, min: -1, max: 1 },
	{ key: "subjectSaturation", label: "Subject saturation", defaultValue: 1, min: 0, max: 2 },
	{ key: "brightAreasExposure", label: "Bright areas", defaultValue: 0, min: -1.5, max: 0.5 },
	{ key: "backgroundExposure", label: "Background exposure", defaultValue: 0, min: -3, max: 3 },
	{ key: "backgroundTemperature", label: "Background temperature", defaultValue: 0, min: -1, max: 1 },
	{ key: "backgroundTint", label: "Background tint", defaultValue: 0, min: -1, max: 1 },
	{ key: "backgroundSaturation", label: "Background saturation", defaultValue: 1, min: 0, max: 2 },
] as const;
const MOTION_FIELDS = [
	{ key: "x", label: "X", fallback: 0, min: -1, max: 1 },
	{ key: "y", label: "Y", fallback: 0, min: -1, max: 1 },
	{ key: "scale", label: "Scale", fallback: 1, min: 0.1, max: 5 },
	{ key: "rotation", label: "Rotation", fallback: 0, min: -180, max: 180 },
	{ key: "opacity", label: "Opacity", fallback: 1, min: 0, max: 1 },
] as const;

function recordOf(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.entries(value).reduce<Record<string, unknown>>((result, [key, entry]) => ({ ...result, [key]: entry }), {});
}
type Point = { x: number; y: number };
type Frame = { at: number; value: Record<string, unknown>; easing?: unknown };
function framesOf(value: unknown): Frame[] {
	if (!Array.isArray(value)) return [];
	const candidates: unknown[] = value;
	return candidates.filter((entry): entry is Frame => !!entry && typeof entry === "object" &&
		"at" in entry && typeof entry.at === "number" &&
		"value" in entry && !!entry.value && typeof entry.value === "object" && !Array.isArray(entry.value));
}
function pointsOf(value: unknown): Point[] {
	if (!Array.isArray(value)) return [];
	const candidates: unknown[] = value;
	return candidates.filter((entry): entry is Point => !!entry && typeof entry === "object" &&
		"x" in entry && typeof entry.x === "number" && "y" in entry && typeof entry.y === "number");
}
function regionsOf(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry)).map(recordOf) : [];
}
function nextPoint(points: Point[]): Point {
	const positions = [0, ...points.map((point) => point.x).sort((a, b) => a - b), 1];
	let gap = 0;
	let start = 0;
	for (let index = 0; index < positions.length - 1; index++) {
		if (positions[index + 1] - positions[index] > gap) {
			gap = positions[index + 1] - positions[index];
			start = positions[index];
		}
	}
	const x = start + gap / 2;
	return { x, y: x };
}

function overlaysOf(clip: Record<string, unknown>): CenatOverlay[] {
	if (!Array.isArray(clip.overlays)) return [];
	const candidates: unknown[] = clip.overlays;
	return candidates.filter((value): value is CenatOverlay =>
		value !== null && typeof value === "object" &&
		"id" in value && typeof value.id === "string" &&
		"kind" in value && typeof value.kind === "string");
}

function wordsOf(overlay: CenatOverlay): TimedWord[] {
	if (!Array.isArray(overlay.words)) return [];
	const candidates: unknown[] = overlay.words;
	return candidates.filter((value): value is TimedWord =>
		value !== null && typeof value === "object" &&
		"text" in value && typeof value.text === "string" &&
		"start" in value && typeof value.start === "number" &&
		"end" in value && typeof value.end === "number");
}

function transitionOf(value: unknown): { type: string; duration: number } | null {
	if (!value || typeof value !== "object" ||
		!("type" in value) || typeof value.type !== "string") return null;
	const duration = "duration" in value && typeof value.duration === "number" ? value.duration : 0.5;
	return { type: value.type, duration };
}

export function CenatEditsTab({ element, trackId, section }: { element: VideoElement | ImageElement; trackId: string; section: "color" | "effects" | "text" | "audio" | "transitions" }) {
	const editor = useEditor();
	const edit = element.cenatEdit;
	const [draft, setDraft] = useState<Record<string, unknown>>(() => structuredClone(edit?.clip ?? {}));
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	const [error, setError] = useState("");
	const [catalog, setCatalog] = useState<Catalog | null>(null);
	const transition = transitionOf(draft.transition);
	useEffect(() => {
		let active = true;
		void fetch(`${CENAT_API_ORIGIN}/api/editor/catalog`)
			.then((response) => response.ok ? response.json() : null)
			.then((value: Catalog | null) => { if (active && value) setCatalog(value); })
			.catch(() => {});
		return () => { active = false; };
	}, []);
	if (!edit) return null;

	const change = ({ key, value }: { key: string; value: unknown }) => setDraft((current) => ({ ...current, [key]: value }));
	const changeNested = ({ parent, key, value }: { parent: string; key: string; value: unknown }) => setDraft((current) => ({
		...current, [parent]: { ...recordOf(current[parent]), [key]: value },
	}));
	const changeCurve = ({ channel, points }: { channel: string; points: Point[] }) => setDraft((current) => ({
		...current, curves: { ...recordOf(current.curves), [channel]: points.slice().sort((a, b) => a.x - b.x) },
	}));
	const changeFrames = ({ key, frames }: { key: "keyframes" | "cropKeyframes"; frames: Frame[] }) =>
		setDraft((current) => ({ ...current, [key]: frames.slice().sort((a, b) => a.at - b.at) }));
	const changeRegions = (regions: Record<string, unknown>[]) => setDraft((current) => ({ ...current, colorRegions: regions }));
	const changeOverlay = ({ index, key, value }: { index: number; key: string; value: unknown }) => setDraft((current) => ({
		...current,
		overlays: overlaysOf(current).map((overlay, i) => i === index ? { ...overlay, [key]: value } : overlay),
	}));
	const changeWord = ({ overlayIndex, wordIndex, key, value }: { overlayIndex: number; wordIndex: number; key: keyof TimedWord; value: string | number }) => setDraft((current) => ({
		...current,
		overlays: overlaysOf(current).map((overlay, i) => {
			if (i !== overlayIndex) return overlay;
			const words = wordsOf(overlay).map((word, j) => j === wordIndex ? { ...word, [key]: value } : word);
			return { ...overlay, words, text: words.map((word) => word.text).join(" ") };
		}),
	}));
	const addOverlay = (kind: "text" | "subtitle" | "sticker" | "graphic") => {
		const start = Number(draft.in);
		const end = Number(draft.out);
		setDraft((current) => ({
			...current,
			overlays: [...overlaysOf(current), {
				id: crypto.randomUUID(), kind, text: kind === "subtitle" ? "New caption" : kind === "text" ? "New title" : "",
				start, end: Math.min(end, start + 3), x: 0.5, y: kind === "subtitle" ? 0.85 : 0.5,
				size: kind === "sticker" ? 0.15 : kind === "graphic" ? 0.16 : 0.08,
				color: "#FFFFFF", background: false,
				...(kind === "sticker" ? { sticker: "star" } : {}),
				...(kind === "graphic" ? { graphic: "arrow", x2: 0.7, y2: 0.62, animation: "draw" } : {}),
			}],
		}));
	};
	const save = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		setProgress(0);
		try {
			if (section === "transitions") {
				const response = catalog ? null : await fetch(`${CENAT_API_ORIGIN}/api/editor/catalog`);
				if (response && !response.ok) throw new Error("Could not load transition timing.");
				const timingCatalog: Catalog = catalog || await response!.json();
				const main = editor.scenes.getActiveSceneOrNull()?.tracks.main;
				if (!main) throw new Error("The main timeline is missing.");
				const elements = main.elements.filter((entry): entry is VideoElement | ImageElement =>
					(entry.type === "video" || entry.type === "image") && !!entry.cenatEdit)
					.slice().sort((a, b) => a.startTime - b.startTime);
				const newStarts = new Map<string, number>();
				let end = 0;
				for (const [index, entry] of elements.entries()) {
					const oldEdit = entry.cenatEdit;
					const clip = entry.id === element.id ? draft : oldEdit?.clip || {};
					const incoming = recordOf(clip.transition);
					const overlap = index && timingCatalog.transitions.some((candidate) => candidate.id === incoming.type && candidate.overlap)
						? Math.max(0, Math.min(Number(incoming.duration ?? 0), elements[index - 1].duration / 120_000 / 2, entry.duration / 120_000 / 2))
						: 0;
					const start = end - overlap;
					newStarts.set(entry.id, start);
					end = start + entry.duration / 120_000;
				}
				const updates = elements.flatMap((entry) => {
					const position = roundMediaTime({ time: (newStarts.get(entry.id) || 0) * 120_000 });
					if (entry.id === element.id) return [{ trackId: main.id, elementId: entry.id,
						patch: { startTime: position, cenatEdit: { ...edit, clip: structuredClone(draft) } } }];
					return entry.startTime === position ? [] : [{ trackId: main.id, elementId: entry.id, patch: { startTime: position } }];
				});
				const scene = editor.scenes.getActiveSceneOrNull();
				for (const layer of [...(scene?.tracks.overlay || []), ...(scene?.tracks.audio || [])]) {
					for (const entry of layer.elements) {
						const anchored = entry.cenatItem?.anchorClipId ||
							(entry.type === "text" || entry.type === "sticker" ? entry.cenatOverlays?.[0]?.clipId : undefined);
						if (typeof anchored !== "string") continue;
						const oldStart = elements.find((candidate) => candidate.id === anchored)?.startTime;
						const newStart = newStarts.get(anchored);
						if (oldStart === undefined || newStart === undefined) continue;
						const delta = roundMediaTime({ time: newStart * 120_000 }) - oldStart;
						if (delta) updates.push({ trackId: layer.id, elementId: entry.id,
							patch: { startTime: roundMediaTime({ time: entry.startTime + delta }) } });
					}
				}
				editor.timeline.updateElements({ updates });
				return;
			}
			const projectId = editor.project.getActive().metadata.id;
			const rendered = await renderCenatClip({
				clip: { ...draft, overlays: undefined },
				fps: edit.fps,
				aspect: edit.aspect,
				onProgress: setProgress,
			});
			const expectedSeconds = (Number(draft.out) - Number(draft.in)) / Number(draft.speed ?? 1);
			if (!Number.isFinite(expectedSeconds) || Math.abs(rendered.duration - expectedSeconds) > 1 / edit.fps)
				throw new Error("The replacement clip has a different duration. Keep the original trim when changing these edits.");
			const still = element.type === "image" ? await renderCenatStill({ videoBlob: rendered.blob }) : null;
			const file = still
				? new File([still], `cenat-edit-${element.id}-${crypto.randomUUID()}.png`, { type: "image/png" })
				: new File([rendered.blob], `cenat-edit-${element.id}-${crypto.randomUUID()}.mp4`, { type: "video/mp4" });
			let asset: MediaAsset | null;
			if (getCenatPrimarySession()) {
				asset = {
					id: crypto.randomUUID(), name: file.name, type: still ? "image" : "video", file,
					url: URL.createObjectURL(file), duration: rendered.duration,
					width: rendered.width, height: rendered.height,
					hasAudio: !still && Number(draft.volume ?? 1) !== 0, ephemeral: true,
					thumbnailUrl: editor.media.getAssets().find((item) => item.id === edit.sourceMediaId)?.thumbnailUrl,
				};
				editor.media.setAssets({ assets: [...editor.media.getAssets(), asset] });
			} else {
				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed || !Number.isFinite(processed.duration)) throw new Error("The replacement video could not be read.");
				asset = await editor.media.addMediaAsset({ projectId, asset: processed });
			}
			if (!asset) throw new Error("The replacement video could not be saved.");
			const sourceDuration = roundMediaTime({ time: Math.round((asset.duration ?? 0) * 120_000) });
			if (sourceDuration < element.duration - 120_000 / edit.fps)
				throw new Error("The replacement video is shorter than the edited timeline clip.");
			editor.timeline.updateElements({ updates: [{
				trackId,
				elementId: element.id,
				patch: {
					mediaId: asset.id,
					...(element.type === "video" ? { isSourceAudioEnabled: Number(draft.volume ?? 1) !== 0 } : {}),
					sourceDuration,
					trimStart: roundMediaTime({ time: 0 }),
					trimEnd: roundMediaTime({ time: Math.max(0, sourceDuration - element.duration) }),
					...(element.type === "video" ? { retime: undefined } : {}),
					cenatEdit: { ...edit, clip: structuredClone(draft), proxyMediaId: asset.id },
				},
			}] });
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "The edit could not be rendered.");
		} finally {
			setBusy(false);
		}
	};

	return <div className="space-y-5 p-4 text-sm">
		<div>
			<h3 className="font-semibold capitalize">{section === "text" ? "Titles and captions" : section}</h3>
		</div>
		{section === "color" && <>
		<label className="block space-y-1"><span>Filter</span>
			<select className="bg-background w-full rounded border p-2" value={String(draft.filter ?? "none")} onChange={(event) => change({ key: "filter", value: event.target.value })}>
				{FILTERS.map((filter) => <option key={filter} value={filter}>{filter}</option>)}
			</select>
		</label>
		<details className="space-y-3" open><summary className="cursor-pointer font-medium">Color grading</summary>
			<div className="grid grid-cols-2 gap-2">{GRADE_CONTROLS.map((field) => <label className="space-y-1" key={field.key}><span>{field.label}</span>
				<input className="bg-background w-full rounded border p-2" type="number" step={field.step} value={Number(draft[field.key] ?? field.defaultValue)} onChange={(event) => change({ key: field.key, value: Number(event.target.value) })} />
			</label>)}</div>
		</details>
		<details className="space-y-3"><summary className="cursor-pointer font-medium">Subject and background</summary>
			<div className="grid grid-cols-2 gap-2 pt-2">{ADVANCED_GRADE_CONTROLS.map((field) => <label className="space-y-1" key={field.key}><span>{field.label}</span>
				<input className="bg-background w-full rounded border p-2" type="number" min={field.min} max={field.max} step="0.05"
					value={Number(draft[field.key] ?? field.defaultValue)} onChange={(event) => change({ key: field.key, value: Number(event.target.value) })} />
			</label>)}</div>
		</details>
		<details><summary className="cursor-pointer font-medium">Curves</summary>
			<div className="space-y-3 pt-2">{["master", "red", "green", "blue"].map((channel) => {
				const points = pointsOf(recordOf(draft.curves)[channel]);
				return <div className="space-y-2 rounded border p-2" key={channel}>
					<div className="flex items-center justify-between"><strong className="capitalize">{channel}</strong><button className="rounded border px-2 py-1" disabled={points.length >= 10}
						onClick={() => changeCurve({ channel, points: [...points, nextPoint(points)] })}>Add point</button></div>
					{points.map((point, index) => <div className="grid grid-cols-[1fr_1fr_auto] gap-1" key={index}>
						<input aria-label={`${channel} input ${index + 1}`} className="bg-background min-w-0 rounded border p-2" type="number" min="0" max="1" step="0.01" value={point.x}
							onChange={(event) => changeCurve({ channel, points: points.map((entry, i) => i === index ? { ...entry, x: Number(event.target.value) } : entry) })} />
						<input aria-label={`${channel} output ${index + 1}`} className="bg-background min-w-0 rounded border p-2" type="number" min="0" max="1" step="0.01" value={point.y}
							onChange={(event) => changeCurve({ channel, points: points.map((entry, i) => i === index ? { ...entry, y: Number(event.target.value) } : entry) })} />
						<button className="rounded border px-2" aria-label={`Remove ${channel} point ${index + 1}`} onClick={() => changeCurve({ channel, points: points.filter((_, i) => i !== index) })}>×</button>
					</div>)}
				</div>;
			})}</div>
		</details>
		<details><summary className="cursor-pointer font-medium">Color regions</summary>
			<div className="space-y-3 pt-2"><button className="rounded border px-2 py-1" disabled={regionsOf(draft.colorRegions).length >= 3}
				onClick={() => changeRegions([...regionsOf(draft.colorRegions), { points: [
					{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 },
				], exposure: 0, feather: 0.015 }])}>Add region</button>
			{regionsOf(draft.colorRegions).map((region, index) => {
				const regions = regionsOf(draft.colorRegions);
				const polygon = pointsOf(region.points);
				const exclusions = Array.isArray(region.exclusions) ? region.exclusions.map(recordOf) : [];
				const update = (next: Record<string, unknown>) => changeRegions(regions.map((entry, i) => i === index ? next : entry));
				return <div className="space-y-2 rounded border p-2" key={index}>
					<div className="flex items-center justify-between"><strong>Region {index + 1}</strong><button className="text-destructive" onClick={() => changeRegions(regions.filter((_, i) => i !== index))}>Remove</button></div>
					<svg role="img" aria-label={`Region ${index + 1} shape`} viewBox="0 0 100 100" className="h-28 w-full rounded border bg-muted">
						<polygon points={polygon.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} fill="#6aafff55" stroke="#6aafff" strokeWidth="1.5" />
						{polygon.map((point, i) => <circle key={i} cx={point.x * 100} cy={point.y * 100} r="2" fill="#ffffff" />)}
					</svg>
					<div className="grid grid-cols-2 gap-2">{polygon.map((point, pointIndex) => <div className="grid grid-cols-2 gap-1" key={pointIndex}>
						<input aria-label={`Region ${index + 1} point ${pointIndex + 1} X`} className="bg-background min-w-0 rounded border p-2" type="number" min="0" max="1" step="0.01" value={point.x}
							onChange={(event) => update({ ...region, points: polygon.map((entry, i) => i === pointIndex ? { ...entry, x: Number(event.target.value) } : entry) })} />
						<input aria-label={`Region ${index + 1} point ${pointIndex + 1} Y`} className="bg-background min-w-0 rounded border p-2" type="number" min="0" max="1" step="0.01" value={point.y}
							onChange={(event) => update({ ...region, points: polygon.map((entry, i) => i === pointIndex ? { ...entry, y: Number(event.target.value) } : entry) })} />
					</div>)}</div>
					<div className="flex gap-2">
						<button type="button" className="rounded border px-2 py-1" disabled={polygon.length >= 32}
							onClick={() => update({ ...region, points: [...polygon, {
								x: (polygon[polygon.length - 1].x + polygon[0].x) / 2,
								y: (polygon[polygon.length - 1].y + polygon[0].y) / 2,
							}] })}>Add point</button>
						<button type="button" className="rounded border px-2 py-1" disabled={polygon.length <= 3}
							onClick={() => update({ ...region, points: polygon.slice(0, -1) })}>Remove last point</button>
					</div>
					<div className="grid grid-cols-2 gap-2">{[
						{ key: "exposure", fallback: 0, min: -1.5, max: 1.5 },
						{ key: "temperature", fallback: 0, min: -1, max: 1 },
						{ key: "tint", fallback: 0, min: -1, max: 1 },
						{ key: "saturation", fallback: 1, min: 0, max: 2 },
						{ key: "feather", fallback: 0.015, min: 0.002, max: 0.1 },
						{ key: "redGain", fallback: 1, min: 0.5, max: 1.5 },
						{ key: "greenGain", fallback: 1, min: 0.5, max: 1.5 },
						{ key: "blueGain", fallback: 1, min: 0.5, max: 1.5 },
						{ key: "redOffset", fallback: 0, min: -0.12, max: 0.12 },
						{ key: "greenOffset", fallback: 0, min: -0.12, max: 0.12 },
						{ key: "blueOffset", fallback: 0, min: -0.12, max: 0.12 },
						{ key: "maxLuma", fallback: 1, min: 0, max: 1 },
						{ key: "lumaFeather", fallback: 0.15, min: 0.01, max: 0.4 },
					].map((field) => <label className="space-y-1" key={field.key}><span>{field.key}</span><input className="bg-background w-full rounded border p-2" type="number"
						min={field.min} max={field.max} step="0.01" value={Number(region[field.key] ?? field.fallback)}
						onChange={(event) => update({ ...region, [field.key]: Number(event.target.value) })} /></label>)}</div>
					<details><summary className="cursor-pointer font-medium">Exclusions ({exclusions.length})</summary>
						<div className="space-y-2 pt-2">
							<button type="button" className="rounded border px-2 py-1" disabled={exclusions.length >= 3}
								onClick={() => update({ ...region, exclusions: [...exclusions, { points: [
									{ x: 0.35, y: 0.35 }, { x: 0.65, y: 0.35 }, { x: 0.65, y: 0.65 }, { x: 0.35, y: 0.65 },
								], feather: 0.015 }] })}>Add exclusion</button>
							{exclusions.map((exclusion, exclusionIndex) => {
								const vertices = pointsOf(exclusion.points);
								const changeExclusion = (next: Record<string, unknown>) => update({ ...region,
									exclusions: exclusions.map((entry, i) => i === exclusionIndex ? next : entry) });
								return <div className="space-y-2 rounded border p-2" key={exclusionIndex}>
									<div className="flex items-center justify-between"><strong>Exclusion {exclusionIndex + 1}</strong>
										<button type="button" className="text-destructive" onClick={() => update({ ...region,
											exclusions: exclusions.filter((_, i) => i !== exclusionIndex) })}>Remove</button></div>
									<label className="block space-y-1"><span>Feather</span><input className="bg-background w-full rounded border p-2"
										type="number" min="0.002" max="0.1" step="0.001" value={Number(exclusion.feather ?? 0.015)}
										onChange={(event) => changeExclusion({ ...exclusion, feather: Number(event.target.value) })} /></label>
									{vertices.map((point, vertexIndex) => <div className="grid grid-cols-2 gap-1" key={vertexIndex}>
										{(["x", "y"] as const).map((key) => <label className="space-y-1" key={key}><span>Point {vertexIndex + 1} {key.toUpperCase()}</span>
											<input className="bg-background w-full rounded border p-2" type="number" min="0" max="1" step="0.01"
												value={point[key]} onChange={(event) => changeExclusion({ ...exclusion,
													points: vertices.map((entry, i) => i === vertexIndex ? { ...entry, [key]: Number(event.target.value) } : entry) })} /></label>)}
									</div>)}
									<div className="flex gap-2">
										<button type="button" className="rounded border px-2 py-1" disabled={vertices.length >= 32}
											onClick={() => changeExclusion({ ...exclusion, points: [...vertices, {
												x: (vertices[vertices.length - 1].x + vertices[0].x) / 2,
												y: (vertices[vertices.length - 1].y + vertices[0].y) / 2,
											}] })}>Add point</button>
										<button type="button" className="rounded border px-2 py-1" disabled={vertices.length <= 3}
											onClick={() => changeExclusion({ ...exclusion, points: vertices.slice(0, -1) })}>Remove last point</button>
									</div>
								</div>;
							})}
						</div>
					</details>
				</div>;
			})}
			</div>
		</details>
		</>}
		{section === "effects" && <>
		<div className="grid grid-cols-2 gap-2">
			<label className="space-y-1"><span>Effect</span><select className="bg-background w-full rounded border p-2" value={String(draft.effect ?? "none")} onChange={(event) => change({ key: "effect", value: event.target.value })}>{(catalog?.effects || EFFECTS.map((id) => ({ id, label: id }))).map((effect) => <option key={effect.id} value={effect.id}>{effect.label}</option>)}</select></label>
			<label className="space-y-1"><span>Amount override</span><input className="bg-background w-full rounded border p-2" type="number" min="0" max="1" step="0.05" placeholder="Default" value={draft.effectAmount == null ? "" : Number(draft.effectAmount)} onChange={(event) => change({ key: "effectAmount", value: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
			<label className="space-y-1"><span>Motion</span><select className="bg-background w-full rounded border p-2" value={String(draft.animation ?? "none")} onChange={(event) => change({ key: "animation", value: event.target.value })}>{ANIMATIONS.map((animation) => <option key={animation} value={animation}>{animation}</option>)}</select></label>
		</div>
		<details><summary className="cursor-pointer font-medium">Framing and stabilization</summary>
			<div className="space-y-3 pt-2">
				<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(draft.flip)} onChange={(event) => change({ key: "flip", value: event.target.checked })} /><span>Flip horizontally</span></label>
				<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(recordOf(draft.stabilize).enabled)}
					onChange={(event) => change({ key: "stabilize", value: { ...recordOf(draft.stabilize), enabled: event.target.checked, strength: Number(recordOf(draft.stabilize).strength ?? 5) } })} /><span>Stabilize footage</span></label>
				{Boolean(recordOf(draft.stabilize).enabled) && <label className="block space-y-1"><span>Stabilization strength</span><input className="bg-background w-full rounded border p-2" type="number" min="1" max="10" step="1"
					value={Number(recordOf(draft.stabilize).strength ?? 5)} onChange={(event) => changeNested({ parent: "stabilize", key: "strength", value: Number(event.target.value) })} /></label>}
				<div className="grid grid-cols-2 gap-2">{(["x", "y"] as const).map((key) => <label className="space-y-1" key={key}><span>Crop {key.toUpperCase()}</span><input className="bg-background w-full rounded border p-2" type="number" min="0" max="1" step="0.01"
					value={Number(recordOf(draft.crop)[key] ?? 0.5)} onChange={(event) => changeNested({ parent: "crop", key, value: Number(event.target.value) })} /></label>)}</div>
				<div className="grid grid-cols-2 gap-2">{[
					{ key: "x", label: "Move X", fallback: 0 }, { key: "y", label: "Move Y", fallback: 0 },
					{ key: "scale", label: "Scale", fallback: 1 }, { key: "rotation", label: "Rotation", fallback: 0 },
					{ key: "opacity", label: "Opacity", fallback: 1 },
				].map((field) => <label className="space-y-1" key={field.key}><span>{field.label}</span><input className="bg-background w-full rounded border p-2" type="number" step="0.01"
					value={Number(recordOf(draft.transform)[field.key] ?? field.fallback)} onChange={(event) => changeNested({ parent: "transform", key: field.key, value: Number(event.target.value) })} /></label>)}</div>
			</div>
		</details>
		{(["keyframes", "cropKeyframes"] as const).map((key) => {
			const frames = framesOf(draft[key]);
			const crop = key === "cropKeyframes";
			const fields = crop ? [
				{ key: "x", label: "Crop X", fallback: 0.5, min: 0, max: 1 },
				{ key: "y", label: "Crop Y", fallback: 0.5, min: 0, max: 1 },
			] : MOTION_FIELDS;
			return <details key={key}><summary className="cursor-pointer font-medium">{crop ? "Crop keyframes" : "Motion keyframes"}</summary>
				<div className="space-y-2 pt-2"><button className="rounded border px-2 py-1" onClick={() => {
					const start = Number(draft.in);
					const end = Number(draft.out);
					const position = frames.length ? Math.min(end, frames[frames.length - 1].at + 0.1) : start;
					changeFrames({ key, frames: [...frames, { at: position, value: crop ? { x: 0.5, y: 0.5 } : { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }] });
				}}>Add keyframe</button>
				{frames.map((frame, index) => <div className="space-y-2 rounded border p-2" key={index}>
					<div className="flex items-end gap-2"><label className="flex-1 space-y-1"><span>Source time (s)</span><input className="bg-background w-full rounded border p-2" type="number" min="0" step="0.01" value={frame.at}
						onChange={(event) => changeFrames({ key, frames: frames.map((entry, i) => i === index ? { ...entry, at: Number(event.target.value) } : entry) })} /></label>
						<button className="rounded border px-2 py-2" aria-label={`Remove ${crop ? "crop" : "motion"} keyframe ${index + 1}`}
							onClick={() => changeFrames({ key, frames: frames.filter((_, i) => i !== index) })}>×</button></div>
					<div className="grid grid-cols-2 gap-2">{fields.map((field) => <label className="space-y-1" key={field.key}><span>{field.label}</span><input className="bg-background w-full rounded border p-2" type="number"
						min={field.min} max={field.max} step="0.01" value={Number(frame.value[field.key] ?? field.fallback)}
						onChange={(event) => changeFrames({ key, frames: frames.map((entry, i) => i === index ? { ...entry, value: { ...entry.value, [field.key]: Number(event.target.value) } } : entry) })} /></label>)}</div>
					{!crop && <label className="block space-y-1"><span>Easing</span><select className="bg-background w-full rounded border p-2"
						value={frame.easing === undefined ? "linear" : typeof frame.easing === "string" ? frame.easing : "custom"}
						onChange={(event) => changeFrames({ key, frames: frames.map((entry, i) => i === index ? { ...entry, easing: event.target.value } : entry) })}>
						{["linear", "smooth", "ease-in", "ease-out", "hold", "custom"].map((option) => <option key={option} value={option} disabled={option === "custom"}>{option}</option>)}
					</select></label>}
				</div>)}
				</div>
			</details>;
		})}
		</>}
		{section === "transitions" && <>
			<label className="block space-y-1"><span>Incoming transition</span>
				<select className="bg-background w-full rounded border p-2" value={transition?.type ?? "none"}
					onChange={(event) => {
						const entry = catalog?.transitions.find((item) => item.id === event.target.value);
						change({ key: "transition", value: event.target.value === "none" ? undefined : { type: event.target.value, duration: entry?.duration?.default ?? 0.5 } });
					}}>
					{(catalog?.transitions || [{ id: "none", label: "Hard cut" }, { id: "cross-dissolve", label: "Cross dissolve" }]).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
				</select>
			</label>
			{transition && <label className="block space-y-1"><span>Duration (seconds)</span><input className="bg-background w-full rounded border p-2" type="number" min="0.1" max="3" step="0.05"
				value={transition.duration}
				onChange={(event) => change({ key: "transition", value: { type: transition.type, duration: Number(event.target.value) } })} /></label>}
		</>}
		{section === "audio" && <>
			<label className="block space-y-1"><span>Source volume</span><input className="bg-background w-full rounded border p-2" type="number" min="0" max="2" step="0.05" value={Number(draft.volume ?? 1)} onChange={(event) => change({ key: "volume", value: Number(event.target.value) })} /></label>
			<div className="grid grid-cols-2 gap-2">{(["audioFadeIn", "audioFadeOut"] as const).map((key) => <label className="space-y-1" key={key}><span>{key === "audioFadeIn" ? "Fade in (s)" : "Fade out (s)"}</span>
				<input className="bg-background w-full rounded border p-2" type="number" min="0" max="3" step="0.1" value={Number(draft[key] ?? 0)} onChange={(event) => change({ key, value: Number(event.target.value) })} /></label>)}</div>
			{(["denoise", "normalize", "voice"] as const).map((key) => <label className="flex items-center gap-2" key={key}><input type="checkbox" checked={Boolean(recordOf(draft.audioProcessing)[key])}
				onChange={(event) => changeNested({ parent: "audioProcessing", key, value: event.target.checked })} /><span>{key === "voice" ? "Voice processing" : key === "denoise" ? "Denoise" : "Normalize"}</span></label>)}
		</>}
		{section === "text" && <>
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2"><h4 className="mr-auto font-medium">Titles and layers</h4>
				{([ ["text", "Title"], ["subtitle", "Caption"], ["sticker", "Sticker"], ["graphic", "Graphic"] ] as const).map(([kind, label]) =>
					<button key={kind} className="rounded border px-2 py-1" onClick={() => addOverlay(kind)}>Add {label.toLowerCase()}</button>)}
			</div>
			{overlaysOf(draft).map((overlay, index) => <div className="space-y-2 rounded border p-3" key={overlay.id}>
				<div className="flex justify-between"><strong>{overlay.kind === "subtitle" ? "Caption" : overlay.kind === "sticker" ? "Sticker" : overlay.kind === "graphic" ? "Graphic" : "Title"}</strong><button className="text-destructive" onClick={() => change({ key: "overlays", value: overlaysOf(draft).filter((_, i) => i !== index) })}>Remove</button></div>
				{(overlay.kind === "text" || overlay.kind === "subtitle") && typeof overlay.text === "string" && wordsOf(overlay).length === 0 && <label className="block space-y-1"><span>Text</span><textarea className="bg-background min-h-20 w-full rounded border p-2" value={overlay.text} onChange={(event) => changeOverlay({ index, key: "text", value: event.target.value })} /></label>}
				{wordsOf(overlay).length > 0 && <div className="space-y-2"><span>Timed words</span>{wordsOf(overlay).map((word, wordIndex) => <div className="grid grid-cols-3 gap-1" key={wordIndex}>
					<input aria-label={`Word ${wordIndex + 1}`} className="bg-background min-w-0 rounded border p-2" value={word.text} onChange={(event) => changeWord({ overlayIndex: index, wordIndex, key: "text", value: event.target.value })} />
					<input aria-label={`Word ${wordIndex + 1} start`} className="bg-background min-w-0 rounded border p-2" type="number" step="0.01" value={word.start} onChange={(event) => changeWord({ overlayIndex: index, wordIndex, key: "start", value: Number(event.target.value) })} />
					<input aria-label={`Word ${wordIndex + 1} end`} className="bg-background min-w-0 rounded border p-2" type="number" step="0.01" value={word.end} onChange={(event) => changeWord({ overlayIndex: index, wordIndex, key: "end", value: Number(event.target.value) })} />
				</div>)}</div>}
				{overlay.kind === "sticker" && <label className="block space-y-1"><span>Sticker</span><select className="bg-background w-full rounded border p-2" value={String(overlay.sticker ?? "star")}
					onChange={(event) => changeOverlay({ index, key: "sticker", value: event.target.value })}>{STICKERS.map((sticker) => <option key={sticker} value={sticker}>{sticker}</option>)}</select></label>}
				{overlay.kind === "graphic" && <label className="block space-y-1"><span>Graphic</span><select className="bg-background w-full rounded border p-2" value={String(overlay.graphic ?? "arrow")}
					onChange={(event) => {
					const graphic = event.target.value;
					setDraft((current) => ({ ...current, overlays: overlaysOf(current).map((entry, i) => i === index ? {
						...entry, graphic, animation: graphic === "disc" || graphic === "badge" ? "pop" : "draw",
						...(graphic === "badge" ? { label: "1" } : {}),
					} : entry) }));
				}}>{GRAPHICS.map((graphic) => <option key={graphic} value={graphic}>{graphic}</option>)}</select></label>}
				{(overlay.kind === "text" || overlay.kind === "subtitle") && <label className="block space-y-1"><span>Font</span><input className="bg-background w-full rounded border p-2" value={String(overlay.font ?? "Arial")} onChange={(event) => changeOverlay({ index, key: "font", value: event.target.value })} /></label>}
				<label className="block space-y-1"><span>Color</span><input className="bg-background h-10 w-full rounded border p-1" type="color" value={String(overlay.color ?? "#ffffff")} onChange={(event) => changeOverlay({ index, key: "color", value: event.target.value })} /></label>
				<div className="grid grid-cols-2 gap-2">
					<label className="space-y-1"><span>Animation</span><select className="bg-background w-full rounded border p-2" value={String(overlay.animation ?? "none")} onChange={(event) => changeOverlay({ index, key: "animation", value: event.target.value })}>{(overlay.kind === "graphic" ? (overlay.graphic === "disc" || overlay.graphic === "badge" ? ["pop", "fade", "none"] : ["draw", "fade", "none"]).map((id) => ({ id, label: id })) : catalog?.textMotion || TEXT_ANIMATIONS.map((id) => ({ id, label: id }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
					{(overlay.kind === "text" || overlay.kind === "subtitle") && <>
					<label className="space-y-1"><span>Text style</span><select className="bg-background w-full rounded border p-2" value={String(overlay.textStyle ?? "none")} onChange={(event) => changeOverlay({ index, key: "textStyle", value: event.target.value })}>{(catalog?.textStyles || TEXT_STYLES.map((id) => ({ id, label: id }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
					{overlay.kind === "text" && <><label className="space-y-1"><span>Title design</span><select className="bg-background w-full rounded border p-2" value={String(overlay.remotionTemplate ?? "none")}
						onChange={(event) => {
						const template = event.target.value === "none" ? undefined : event.target.value;
						setDraft((current) => ({ ...current, overlays: overlaysOf(current).map((entry, i) => i === index ? {
							...entry, remotionTemplate: template, titleMotion: template ? String(entry.titleMotion ?? "standard") : undefined,
							titleContext: template ? entry.titleContext : undefined,
							titleCurve: template === "arc" ? entry.titleCurve : undefined,
							...(template === "stacked" ? { size: Math.max(0.2, Number(entry.size ?? 0.2)) } : {}),
						} : entry) }));
					}}>{TITLE_TEMPLATES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
					{overlay.remotionTemplate && <label className="space-y-1"><span>Title motion</span><select className="bg-background w-full rounded border p-2" value={String(overlay.titleMotion ?? "standard")} onChange={(event) => changeOverlay({ index, key: "titleMotion", value: event.target.value })}>{["restrained", "standard", "punchy"].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}</>}
					<label className="space-y-1"><span>Weight</span><input className="bg-background w-full rounded border p-2" type="number" step="100" value={Number(overlay.weight ?? 700)} onChange={(event) => changeOverlay({ index, key: "weight", value: Number(event.target.value) })} /></label>
					<label className="space-y-1"><span>Tracking</span><input className="bg-background w-full rounded border p-2" type="number" step="0.001" value={Number(overlay.tracking ?? 0)} onChange={(event) => changeOverlay({ index, key: "tracking", value: Number(event.target.value) })} /></label>
					<label className="space-y-1"><span>Outline</span><input className="bg-background w-full rounded border p-2" type="number" step="0.001" value={Number(overlay.outline ?? 0)} onChange={(event) => changeOverlay({ index, key: "outline", value: Number(event.target.value) })} /></label>
					<label className="space-y-1"><span>Outline color</span><input className="bg-background h-10 w-full rounded border p-1" type="color" value={String(overlay.outlineColor ?? "#171717")} onChange={(event) => changeOverlay({ index, key: "outlineColor", value: event.target.value })} /></label>
					</>}
				</div>
				{overlay.kind === "text" && <details><summary className="cursor-pointer font-medium">Motion and depth</summary><div className="grid grid-cols-2 gap-2 pt-2">
					<label className="space-y-1"><span>Exit animation</span><select className="bg-background w-full rounded border p-2" value={String(overlay.exitAnimation ?? "none")}
						onChange={(event) => changeOverlay({ index, key: "exitAnimation", value: event.target.value === "none" ? undefined : event.target.value })}>
						{(catalog?.textMotion || TEXT_ANIMATIONS.map((id) => ({ id, label: id }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
					</select></label>
					<label className="space-y-1"><span>Continuous motion</span><select className="bg-background w-full rounded border p-2" value={String(overlay.floatStyle ?? "none")}
						onChange={(event) => changeOverlay({ index, key: "floatStyle", value: event.target.value === "none" ? undefined : event.target.value })}>
						{FLOAT_STYLES.map((item) => <option key={item} value={item}>{item}</option>)}
					</select></label>
					<label className="space-y-1"><span>Depth</span><select className="bg-background w-full rounded border p-2" value={String(overlay.depth ?? "front")}
						onChange={(event) => changeOverlay({ index, key: "depth", value: event.target.value })}>
						<option value="front">Front</option><option value="behind-subject">Behind subject</option>
					</select></label>
					{Boolean(overlay.remotionTemplate) && <label className="space-y-1"><span>Supporting text</span><input className="bg-background w-full rounded border p-2" maxLength={80} value={String(overlay.titleContext ?? "")}
						onChange={(event) => changeOverlay({ index, key: "titleContext", value: event.target.value })} /></label>}
					{overlay.remotionTemplate === "arc" && <label className="space-y-1"><span>Arc curve</span><input className="bg-background w-full rounded border p-2" type="number" min="-0.8" max="0.8" step="0.05" value={Number(overlay.titleCurve ?? 0)}
						onChange={(event) => changeOverlay({ index, key: "titleCurve", value: Number(event.target.value) })} /></label>}
				</div></details>}
				{(overlay.kind === "text" || overlay.kind === "subtitle") && <div className="grid grid-cols-2 gap-2">
					<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(overlay.italic)} onChange={(event) => changeOverlay({ index, key: "italic", value: event.target.checked })} /><span>Italic</span></label>
					<label className="space-y-1"><span>Rotation</span><input className="bg-background w-full rounded border p-2" type="number" min="-45" max="45" step="1" value={Number(overlay.rotation ?? 0)} onChange={(event) => changeOverlay({ index, key: "rotation", value: Number(event.target.value) })} /></label>
					{overlay.kind === "subtitle" && <label className="space-y-1"><span>Word highlight</span><input className="bg-background h-10 w-full rounded border p-1" type="color" value={String(overlay.highlight ?? "#ffff00")} onChange={(event) => changeOverlay({ index, key: "highlight", value: event.target.value })} /></label>}
				</div>}
				{overlay.kind !== "graphic" && <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(overlay.background)} onChange={(event) => changeOverlay({ index, key: "background", value: event.target.checked })} /><span>Background</span></label>}
				{overlay.kind === "graphic" && String(overlay.graphic) === "badge" && <label className="block space-y-1"><span>Badge label</span><input className="bg-background w-full rounded border p-2" maxLength={3}
					value={String(overlay.label ?? "1")} onChange={(event) => changeOverlay({ index, key: "label", value: event.target.value })} /></label>}
				<div className="grid grid-cols-2 gap-2">
					{(["start", "end", "x", "y", "size"] as const).map((key) => <label className="space-y-1" key={key}><span>{key}</span><input className="bg-background w-full rounded border p-2" type="number" step={key === "start" || key === "end" ? "0.01" : "0.001"} value={Number(overlay[key] ?? 0)} onChange={(event) => changeOverlay({ index, key, value: Number(event.target.value) })} /></label>)}
				{overlay.kind === "graphic" && ["arrow", "curve", "line"].includes(String(overlay.graphic)) && (["x2", "y2"] as const).map((key) => <label className="space-y-1" key={key}><span>{key}</span><input className="bg-background w-full rounded border p-2" type="number" step="0.001" value={Number(overlay[key] ?? 0.7)} onChange={(event) => changeOverlay({ index, key, value: Number(event.target.value) })} /></label>)}
				</div>
			</div>)}
		</div>
		</>}
		{error && <p className="text-destructive" role="alert">{error}</p>}
		<button className="bg-primary text-primary-foreground w-full rounded px-4 py-2 disabled:opacity-50" disabled={busy || JSON.stringify(draft) === JSON.stringify(edit.clip)} onClick={() => void save()}>{busy ? `Updating preview… ${progress}%` : "Apply changes"}</button>
	</div>;
}
