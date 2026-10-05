"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { renderCenatClip } from "@/lib/cenat-proxy";
import type { VideoElement } from "@/timeline/types";
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
const TEXT_STYLES = ["none", "shadow", "outline", "sticker", "glow", "gradient", "highlight", "underline", "strike", "circle", "3d-shadow"];
type CatalogEntry = { id: string; label: string; duration?: { min: number; max: number; default: number }; defaultAmount?: number };
type Catalog = { transitions: CatalogEntry[]; effects: CatalogEntry[]; textMotion: CatalogEntry[]; textStyles: CatalogEntry[] };
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

export function CenatEditsTab({ element, trackId, section }: { element: VideoElement; trackId: string; section: "color" | "effects" | "text" | "audio" | "transitions" }) {
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
		void fetch("http://127.0.0.1:3001/api/editor/catalog")
			.then((response) => response.ok ? response.json() : null)
			.then((value: Catalog | null) => { if (active && value) setCatalog(value); })
			.catch(() => {});
		return () => { active = false; };
	}, []);
	if (!edit) return null;

	const change = ({ key, value }: { key: string; value: unknown }) => setDraft((current) => ({ ...current, [key]: value }));
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
	const addTitle = () => {
		const start = Number(draft.in);
		const end = Number(draft.out);
		setDraft((current) => ({
			...current,
			overlays: [...overlaysOf(current), {
				id: crypto.randomUUID(), kind: "text", text: "New title", start,
				end: Math.min(end, start + 3), x: 0.5, y: 0.5, size: 0.08,
				font: "Arial", color: "#FFFFFF", background: false,
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
				editor.timeline.updateElements({ updates: [{ trackId, elementId: element.id,
					patch: { cenatEdit: { ...edit, clip: structuredClone(draft) } } }] });
				return;
			}
			const projectId = editor.project.getActive().metadata.id;
			const rendered = await renderCenatClip({
				clip: draft,
				fps: edit.fps,
				aspect: edit.aspect,
				onProgress: setProgress,
			});
			const expectedSeconds = (Number(draft.out) - Number(draft.in)) / Number(draft.speed ?? 1);
			if (!Number.isFinite(expectedSeconds) || Math.abs(rendered.duration - expectedSeconds) > 1 / edit.fps)
				throw new Error("The replacement clip has a different duration. Keep the original trim when changing these edits.");
			const file = new File([rendered.blob], `cenat-edit-${element.id}-${crypto.randomUUID()}.mp4`, { type: "video/mp4" });
			let asset: MediaAsset | null;
			if (getCenatPrimarySession()) {
				asset = {
					id: crypto.randomUUID(), name: file.name, type: "video", file,
					url: URL.createObjectURL(file), duration: rendered.duration,
					width: rendered.width, height: rendered.height,
					hasAudio: Number(draft.volume ?? 1) !== 0, ephemeral: true,
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
					isSourceAudioEnabled: Number(draft.volume ?? 1) !== 0,
					sourceDuration,
					trimStart: roundMediaTime({ time: 0 }),
					trimEnd: roundMediaTime({ time: Math.max(0, sourceDuration - element.duration) }),
					retime: undefined,
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
		</>}
		{section === "effects" && <>
		<div className="grid grid-cols-2 gap-2">
			<label className="space-y-1"><span>Effect</span><select className="bg-background w-full rounded border p-2" value={String(draft.effect ?? "none")} onChange={(event) => change({ key: "effect", value: event.target.value })}>{(catalog?.effects || EFFECTS.map((id) => ({ id, label: id }))).map((effect) => <option key={effect.id} value={effect.id}>{effect.label}</option>)}</select></label>
			<label className="space-y-1"><span>Amount override</span><input className="bg-background w-full rounded border p-2" type="number" min="0" max="1" step="0.05" placeholder="Default" value={draft.effectAmount == null ? "" : Number(draft.effectAmount)} onChange={(event) => change({ key: "effectAmount", value: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
			<label className="space-y-1"><span>Motion</span><select className="bg-background w-full rounded border p-2" value={String(draft.animation ?? "none")} onChange={(event) => change({ key: "animation", value: event.target.value })}>{ANIMATIONS.map((animation) => <option key={animation} value={animation}>{animation}</option>)}</select></label>
		</div>
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
		{section === "audio" && <label className="block space-y-1"><span>Source volume</span><input className="bg-background w-full rounded border p-2" type="number" min="0" max="2" step="0.05" value={Number(draft.volume ?? 1)} onChange={(event) => change({ key: "volume", value: Number(event.target.value) })} /></label>}
		{section === "text" && <>
		<div className="space-y-3">
			<div className="flex items-center justify-between"><h4 className="font-medium">Titles and captions</h4><button className="rounded border px-2 py-1" onClick={addTitle}>Add title</button></div>
			{overlaysOf(draft).map((overlay, index) => <div className="space-y-2 rounded border p-3" key={overlay.id}>
				<div className="flex justify-between"><strong>{overlay.kind === "subtitle" ? "Caption" : "Title"}</strong><button className="text-destructive" onClick={() => change({ key: "overlays", value: overlaysOf(draft).filter((_, i) => i !== index) })}>Remove</button></div>
				{typeof overlay.text === "string" && wordsOf(overlay).length === 0 && <label className="block space-y-1"><span>Text</span><textarea className="bg-background min-h-20 w-full rounded border p-2" value={overlay.text} onChange={(event) => changeOverlay({ index, key: "text", value: event.target.value })} /></label>}
				{wordsOf(overlay).length > 0 && <div className="space-y-2"><span>Timed words</span>{wordsOf(overlay).map((word, wordIndex) => <div className="grid grid-cols-3 gap-1" key={wordIndex}>
					<input aria-label={`Word ${wordIndex + 1}`} className="bg-background min-w-0 rounded border p-2" value={word.text} onChange={(event) => changeWord({ overlayIndex: index, wordIndex, key: "text", value: event.target.value })} />
					<input aria-label={`Word ${wordIndex + 1} start`} className="bg-background min-w-0 rounded border p-2" type="number" step="0.01" value={word.start} onChange={(event) => changeWord({ overlayIndex: index, wordIndex, key: "start", value: Number(event.target.value) })} />
					<input aria-label={`Word ${wordIndex + 1} end`} className="bg-background min-w-0 rounded border p-2" type="number" step="0.01" value={word.end} onChange={(event) => changeWord({ overlayIndex: index, wordIndex, key: "end", value: Number(event.target.value) })} />
				</div>)}</div>}
				<label className="block space-y-1"><span>Font</span><input className="bg-background w-full rounded border p-2" value={String(overlay.font ?? "Arial")} onChange={(event) => changeOverlay({ index, key: "font", value: event.target.value })} /></label>
				<label className="block space-y-1"><span>Color</span><input className="bg-background h-10 w-full rounded border p-1" type="color" value={String(overlay.color ?? "#ffffff")} onChange={(event) => changeOverlay({ index, key: "color", value: event.target.value })} /></label>
				<div className="grid grid-cols-2 gap-2">
					<label className="space-y-1"><span>Animation</span><select className="bg-background w-full rounded border p-2" value={String(overlay.animation ?? "none")} onChange={(event) => changeOverlay({ index, key: "animation", value: event.target.value })}>{(catalog?.textMotion || TEXT_ANIMATIONS.map((id) => ({ id, label: id }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
					<label className="space-y-1"><span>Text style</span><select className="bg-background w-full rounded border p-2" value={String(overlay.textStyle ?? "none")} onChange={(event) => changeOverlay({ index, key: "textStyle", value: event.target.value })}>{(catalog?.textStyles || TEXT_STYLES.map((id) => ({ id, label: id }))).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
					<label className="space-y-1"><span>Title design</span><select className="bg-background w-full rounded border p-2" value={String(overlay.remotionTemplate ?? "none")} onChange={(event) => changeOverlay({ index, key: "remotionTemplate", value: event.target.value === "none" ? undefined : event.target.value })}>{TITLE_TEMPLATES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
					<label className="space-y-1"><span>Title motion</span><select className="bg-background w-full rounded border p-2" value={String(overlay.titleMotion ?? "standard")} onChange={(event) => changeOverlay({ index, key: "titleMotion", value: event.target.value })}>{["restrained", "standard", "punchy"].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
					<label className="space-y-1"><span>Weight</span><input className="bg-background w-full rounded border p-2" type="number" step="100" value={Number(overlay.weight ?? 700)} onChange={(event) => changeOverlay({ index, key: "weight", value: Number(event.target.value) })} /></label>
					<label className="space-y-1"><span>Tracking</span><input className="bg-background w-full rounded border p-2" type="number" step="0.001" value={Number(overlay.tracking ?? 0)} onChange={(event) => changeOverlay({ index, key: "tracking", value: Number(event.target.value) })} /></label>
					<label className="space-y-1"><span>Outline</span><input className="bg-background w-full rounded border p-2" type="number" step="0.001" value={Number(overlay.outline ?? 0)} onChange={(event) => changeOverlay({ index, key: "outline", value: Number(event.target.value) })} /></label>
					<label className="space-y-1"><span>Outline color</span><input className="bg-background h-10 w-full rounded border p-1" type="color" value={String(overlay.outlineColor ?? "#171717")} onChange={(event) => changeOverlay({ index, key: "outlineColor", value: event.target.value })} /></label>
				</div>
				<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(overlay.background)} onChange={(event) => changeOverlay({ index, key: "background", value: event.target.checked })} /><span>Background</span></label>
				<div className="grid grid-cols-2 gap-2">
					{(["start", "end", "x", "y", "size"] as const).map((key) => <label className="space-y-1" key={key}><span>{key}</span><input className="bg-background w-full rounded border p-2" type="number" step={key === "start" || key === "end" ? "0.01" : "0.001"} value={Number(overlay[key] ?? 0)} onChange={(event) => changeOverlay({ index, key, value: Number(event.target.value) })} /></label>)}
				</div>
			</div>)}
		</div>
		</>}
		{error && <p className="text-destructive" role="alert">{error}</p>}
		<button className="bg-primary text-primary-foreground w-full rounded px-4 py-2 disabled:opacity-50" disabled={busy || JSON.stringify(draft) === JSON.stringify(edit.clip)} onClick={() => void save()}>{busy ? `Updating preview… ${progress}%` : "Apply changes"}</button>
	</div>;
}
