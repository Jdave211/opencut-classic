"use client";
/* eslint-disable opencut/prefer-object-params -- Compact field factories keep form labels and keys readable. */

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import type { AudioElement, ImageElement, VideoElement } from "@/timeline/types";

type TrackElement = AudioElement | ImageElement | VideoElement;
type Item = Record<string, unknown>;
const BLENDS = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "hardlight", "softlight"];

function fieldNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function fields(value: unknown): Item {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.entries(value).reduce<Item>((result, [key, entry]) => ({ ...result, [key]: entry }), {});
}

export function CenatTrackTab({ element, trackId }: { element: TrackElement; trackId: string }) {
	const editor = useEditor();
	const [draft, setDraft] = useState<Item>(() => structuredClone(element.cenatItem ?? {}));
	const [error, setError] = useState("");
	const set = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
	const setNested = (parent: string, key: string, value: unknown) => setDraft((current) => ({
		...current,
		[parent]: { ...fields(current[parent]), [key]: value },
	}));
	const nested = (key: string): Item => fields(draft[key]);
	const numberInput = (label: string, key: string, fallback: number, min: number, max: number, step: number) =>
		<label className="space-y-1"><span>{label}</span><input className="bg-background w-full rounded border p-2" type="number"
			min={min} max={max} step={step} value={fieldNumber(draft[key], fallback)}
			onChange={(event) => set(key, Number(event.target.value))} /></label>;
	const nestedNumber = (parent: string, label: string, key: string, fallback: number, min: number, max: number, step: number) =>
		<label className="space-y-1"><span>{label}</span><input className="bg-background w-full rounded border p-2" type="number"
			min={min} max={max} step={step} value={fieldNumber(nested(parent)[key], fallback)}
			onChange={(event) => setNested(parent, key, Number(event.target.value))} /></label>;
	const checkbox = (label: string, parent: string, key: string) =>
		<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(nested(parent)[key])}
			onChange={(event) => setNested(parent, key, event.target.checked)} /><span>{label}</span></label>;
	const apply = () => {
		try {
			if (fieldNumber(draft.out, 0) <= fieldNumber(draft.in, 0)) throw new Error("Source out must follow source in.");
			editor.timeline.updateElements({ updates: [{ trackId, elementId: element.id,
				patch: { cenatItem: structuredClone(draft) } }] });
			setError("");
		} catch (cause) { setError(cause instanceof Error ? cause.message : "The layer could not be saved."); }
	};
	if (!element.cenatItem) return null;
	const visual = element.type !== "audio";
	return <div className="space-y-5 p-4 text-sm">
		<h3 className="font-semibold">{visual ? "Layer settings" : "Mix settings"}</h3>
		<div className="grid grid-cols-2 gap-2">
			{numberInput("Fade in (s)", "fadeIn", 0, 0, 10, 0.1)}
			{numberInput("Fade out (s)", "fadeOut", 0, 0, 10, 0.1)}
		</div>
		<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(draft.ducking)}
			onChange={(event) => set("ducking", event.target.checked)} /><span>Duck main audio while this plays</span></label>
		{visual && <>
			<label className="block space-y-1"><span>Fit inside layer</span><select className="bg-background w-full rounded border p-2"
				value={String(draft.fit ?? "contain")} onChange={(event) => set("fit", event.target.value)}>
				<option value="contain">Contain</option><option value="cover">Cover</option>
			</select></label>
			<label className="block space-y-1"><span>Blend mode</span><select className="bg-background w-full rounded border p-2"
				value={String(draft.blendMode ?? "normal")} onChange={(event) => set("blendMode", event.target.value === "normal" ? undefined : event.target.value)}>
				{BLENDS.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
			</select></label>
			{element.type !== "image" && <details><summary className="cursor-pointer font-medium">Chroma key</summary>
				<div className="space-y-2 pt-2">
					<label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(nested("chromaKey").enabled)}
						onChange={(event) => set("chromaKey", event.target.checked
						? { enabled: true, color: String(nested("chromaKey").color ?? "#00ff00"),
							similarity: fieldNumber(nested("chromaKey").similarity, 0.2), blend: fieldNumber(nested("chromaKey").blend, 0.1) }
						: undefined)} /><span>Enable chroma key</span></label>
					{draft.chromaKey !== undefined && <><label className="block space-y-1"><span>Key color</span><input type="color" className="bg-background h-10 w-full rounded border p-1"
						value={String(nested("chromaKey").color ?? "#00ff00")}
						onChange={(event) => setNested("chromaKey", "color", event.target.value)} /></label>
					<div className="grid grid-cols-2 gap-2">
						{nestedNumber("chromaKey", "Similarity", "similarity", 0.2, 0.01, 1, 0.01)}
						{nestedNumber("chromaKey", "Blend", "blend", 0.1, 0, 1, 0.01)}
					</div></>}
				</div>
			</details>}
			<details><summary className="cursor-pointer font-medium">Mask</summary>
				<div className="space-y-2 pt-2">
					<label className="block space-y-1"><span>Shape</span><select className="bg-background w-full rounded border p-2"
						value={String(nested("mask").shape ?? "none")}
						onChange={(event) => set("mask", event.target.value === "none" ? undefined : { shape: event.target.value, x: 0, y: 0, width: 1, height: 1, feather: 0, invert: false })}>
						{["none", "rect", "ellipse", "linear", "polygon"].map((shape) => <option key={shape} value={shape}>{shape}</option>)}
					</select></label>
					{draft.mask !== undefined && <><div className="grid grid-cols-2 gap-2">
						{["x", "y", "width", "height"].map((key) => <div key={key}>{nestedNumber("mask", key, key, key === "width" || key === "height" ? 1 : 0, 0, 1, 0.01)}</div>)}
						{nestedNumber("mask", "Feather", "feather", 0, 0, 1, 0.01)}
					</div>{checkbox("Invert mask", "mask", "invert")}</>}
				</div>
			</details>
			{element.type !== "image" && <details><summary className="cursor-pointer font-medium">Background removal</summary>
				<div className="space-y-2 pt-2"><label className="block space-y-1"><span>Background</span><select className="bg-background w-full rounded border p-2"
					value={draft.backgroundRemoval ? String(nested("backgroundRemoval").background) : "off"}
					onChange={(event) => set("backgroundRemoval", event.target.value === "off" ? undefined : { background: event.target.value })}>
					<option value="off">Off</option><option value="transparent">Transparent</option><option value="#000000">Black</option><option value="#ffffff">White</option>
				</select></label></div>
			</details>}
		</>}
		<details><summary className="cursor-pointer font-medium">Source audio</summary>
			<div className="space-y-2 pt-2"><div className="grid grid-cols-2 gap-2">
				{numberInput("Audio fade in (s)", "audioFadeIn", 0, 0, 3, 0.1)}
				{numberInput("Audio fade out (s)", "audioFadeOut", 0, 0, 3, 0.1)}
			</div>
			{checkbox("Denoise", "audioProcessing", "denoise")}
			{checkbox("Normalize", "audioProcessing", "normalize")}
			{checkbox("Voice processing", "audioProcessing", "voice")}
			</div>
		</details>
		{error && <p className="text-destructive" role="alert">{error}</p>}
		<button className="bg-primary text-primary-foreground w-full rounded px-4 py-2 disabled:opacity-50"
			disabled={JSON.stringify(draft) === JSON.stringify(element.cenatItem)} onClick={apply}>Apply layer settings</button>
	</div>;
}
