"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import type { StickerElement } from "@/timeline/types";

const STICKERS = ["star", "heart", "arrow", "sparkle", "circle"];
const GRAPHICS = ["arrow", "curve", "loop", "line", "disc", "badge"];
const MOTIONS = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "pop", "bounce", "zoom-blur", "rise", "stamp"];

export function CenatGraphicTab({ element, trackId }: { element: StickerElement; trackId: string }) {
	const editor = useEditor();
	const base = element.cenatOverlays?.[0]?.overlay || {};
	const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...base, ...element.cenatOverlayStyle }));
	const kind = draft.kind === "graphic" ? "graphic" : "sticker";
	const change = ({ key, value }: { key: string; value: unknown }) => setDraft((current) => ({ ...current, [key]: value }));
	const numberInput = ({ key, label, min, max, step, fallback }: { key: string; label: string; min: number; max: number; step: number; fallback: number }) =>
		<label className="space-y-1" key={key}><span>{label}</span><input className="bg-background w-full rounded border p-2"
			type="number" min={min} max={max} step={step} value={Number(draft[key] ?? fallback)}
			onChange={(event) => change({ key, value: Number(event.target.value) })} /></label>;
	const apply = () => {
		const style: Record<string, unknown> = { ...draft, kind };
		for (const key of ["id", "start", "end", "openCutGroupId", "lane"]) delete style[key];
		editor.timeline.updateElements({ updates: [{ trackId, elementId: element.id,
			patch: { name: kind === "sticker" ? `${String(style.sticker || "star")} sticker` : `${String(style.graphic || "arrow")} graphic`,
				cenatOverlayStyle: style } }] });
	};
	return <div className="space-y-4 p-4 text-sm">
		<h3 className="font-semibold">Sticker & graphic</h3>
		<p className="text-muted-foreground">Drag this layer on the timeline to change its timing.</p>
		<label className="block space-y-1"><span>Type</span><select className="bg-background w-full rounded border p-2" value={kind}
			onChange={(event) => setDraft((current) => event.target.value === "graphic"
				? { ...current, kind: "graphic", graphic: current.graphic || "arrow", x2: current.x2 ?? 0.7,
					y2: current.y2 ?? 0.62, animation: "draw" }
				: { ...current, kind: "sticker", sticker: current.sticker || "star",
					size: Math.min(0.3, Number(current.size ?? 0.15)), animation: "none" })}>
			<option value="sticker">Sticker</option><option value="graphic">Graphic</option>
		</select></label>
		<label className="block space-y-1"><span>{kind === "sticker" ? "Sticker" : "Graphic"}</span>
			<select className="bg-background w-full rounded border p-2" value={String(kind === "sticker" ? draft.sticker || "star" : draft.graphic || "arrow")}
				onChange={(event) => {
					const value = event.target.value;
					setDraft((current) => ({
						...current, [kind]: value,
						...(kind === "graphic" ? { animation: value === "disc" || value === "badge" ? "pop" : "draw" } : {}),
					}));
				}}>
				{(kind === "sticker" ? STICKERS : GRAPHICS).map((id) => <option key={id} value={id}>{id}</option>)}
			</select></label>
		<label className="block space-y-1"><span>Color</span><input className="bg-background h-10 w-full rounded border p-1"
			type="color" value={String(draft.color || "#ffffff")} onChange={(event) => change({ key: "color", value: event.target.value })} /></label>
		<div className="grid grid-cols-2 gap-2">
			{numberInput({ key: "x", label: "Horizontal", min: kind === "graphic" ? -0.3 : 0.05, max: kind === "graphic" ? 1.3 : 0.95, step: 0.01, fallback: 0.5 })}
			{numberInput({ key: "y", label: "Vertical", min: kind === "graphic" ? -0.3 : 0.05, max: kind === "graphic" ? 1.3 : 0.95, step: 0.01, fallback: 0.5 })}
			{numberInput({ key: "size", label: "Size", min: kind === "graphic" ? 0.01 : 0.025, max: kind === "graphic" ? 1.5 : 0.3, step: 0.01, fallback: kind === "graphic" ? 0.16 : 0.15 })}
			{kind === "graphic" && ["arrow", "curve", "line"].includes(String(draft.graphic || "arrow")) && <>
				{numberInput({ key: "x2", label: "End horizontal", min: -0.3, max: 1.3, step: 0.01, fallback: 0.7 })}
				{numberInput({ key: "y2", label: "End vertical", min: -0.3, max: 1.3, step: 0.01, fallback: 0.62 })}
			</>}
			{kind === "graphic" && ["arrow", "curve", "line", "loop"].includes(String(draft.graphic || "arrow")) &&
				numberInput({ key: "strokeWidth", label: "Line width", min: 0.002, max: 0.03, step: 0.001, fallback: 0.008 })}
			{kind === "graphic" && String(draft.graphic) === "loop" && numberInput({ key: "width", label: "Loop width", min: 0.01, max: 1.5, step: 0.01, fallback: 0.25 })}
		</div>
		{kind === "graphic" && String(draft.graphic) === "badge" && <label className="block space-y-1"><span>Badge label</span>
			<input className="bg-background w-full rounded border p-2" maxLength={3} value={String(draft.label || "1")}
				onChange={(event) => change({ key: "label", value: event.target.value })} /></label>}
		<label className="block space-y-1"><span>Entrance</span><select className="bg-background w-full rounded border p-2"
			value={String(draft.animation || (kind === "graphic" ? "draw" : "none"))}
			onChange={(event) => change({ key: "animation", value: event.target.value })}>
			{(kind === "graphic" ? ["draw", "pop", "fade", "none"] : MOTIONS).map((id) => <option key={id} value={id}>{id}</option>)}
		</select></label>
		{kind === "sticker" && <label className="block space-y-1"><span>Exit</span><select className="bg-background w-full rounded border p-2"
			value={String(draft.exitAnimation || "none")} onChange={(event) => change({ key: "exitAnimation", value: event.target.value })}>
			{MOTIONS.map((id) => <option key={id} value={id}>{id}</option>)}
		</select></label>}
		<button type="button" className="bg-primary text-primary-foreground w-full rounded px-4 py-2"
			onClick={apply}>Apply design</button>
	</div>;
}
