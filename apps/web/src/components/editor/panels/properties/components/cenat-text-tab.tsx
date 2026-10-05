"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import type { TextElement } from "@/timeline/types";

const MOTIONS = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "typewriter", "word-pop", "bounce", "pop", "blur-in", "karaoke", "spotlight-word", "zoom-blur", "rise", "word-slide", "glitch", "split-in", "appear", "drop-in", "stamp", "shimmer"];
const STYLES = ["none", "shadow", "outline", "sticker", "glow", "gradient", "highlight", "underline", "strike", "circle", "3d-shadow"];
const FLOATS = ["none", "drift-up", "drift-left", "drift-right", "sway", "float", "breathe"];
const TEMPLATES = ["none", "title", "chapter", "editorial", "locator", "kinetic", "arc", "stacked"];
type TimedWord = { text: string; start: number; end: number; [key: string]: unknown };
function timedWords(value: unknown): TimedWord[] {
	return Array.isArray(value) ? value.filter((word): word is TimedWord => !!word && typeof word === "object" &&
		"text" in word && typeof word.text === "string" && "start" in word && typeof word.start === "number" &&
		"end" in word && typeof word.end === "number") : [];
}

export function CenatTextTab({ element, trackId }: { element: TextElement; trackId: string }) {
	const editor = useEditor();
	const base = element.cenatOverlays?.[0]?.overlay || {};
	const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...base, ...element.cenatTextStyle }));
	const kind = draft.kind === "text" || draft.kind === "subtitle" ? draft.kind : element.cenatTextKind || "text";
	const words = timedWords(draft.words);
	const change = ({ key, value }: { key: string; value: unknown }) => setDraft((current) => ({ ...current, [key]: value }));
	const changeWord = ({ index, key, value }: { index: number; key: "text" | "start" | "end"; value: string | number }) =>
		change({ key: "words", value: words.map((word, current) => current === index ? { ...word, [key]: value } : word) });
	const apply = () => {
		const style: Record<string, unknown> = { ...draft, kind };
		delete style.id;
		delete style.start;
		delete style.end;
		delete style.openCutGroupId;
		if (JSON.stringify(style.words) === JSON.stringify(base.words)) delete style.words;
		if (kind === "subtitle") {
			delete style.remotionTemplate;
			delete style.titleMotion;
			delete style.titleCurve;
			delete style.titleContext;
			delete style.depth;
		} else delete style.words;
		const content = words.length && kind === "subtitle" ? words.map((word) => word.text.trim()).join(" ") : undefined;
		editor.timeline.updateElements({ updates: [{ trackId, elementId: element.id,
			patch: { cenatTextKind: kind, cenatTextStyle: style,
				...(content && content !== element.params.content ? { params: { content } } : {}) } }] });
	};
	const select = ({ label, key, values }: { label: string; key: string; values: string[] }) => <label className="block space-y-1" key={key}><span>{label}</span>
		<select className="bg-background w-full rounded border p-2" value={String(draft[key] ?? "none")}
			onChange={(event) => change({ key, value: event.target.value === "none" ? undefined : event.target.value })}>
			{values.map((value) => <option key={value} value={value}>{value}</option>)}
		</select></label>;
	return <div className="space-y-4 p-4 text-sm">
		<h3 className="font-semibold">Cenat text</h3>
		<label className="block space-y-1"><span>Type</span><select className="bg-background w-full rounded border p-2"
			value={kind} onChange={(event) => change({ key: "kind", value: event.target.value })}>
			<option value="text">Title</option><option value="subtitle">Caption</option>
		</select></label>
		{select({ label: "Entrance", key: "animation", values: MOTIONS })}
		{select({ label: "Exit", key: "exitAnimation", values: MOTIONS })}
		{select({ label: "Text treatment", key: "textStyle", values: STYLES })}
		{select({ label: "Motion while visible", key: "floatStyle", values: FLOATS })}
		{kind === "text" && select({ label: "Title design", key: "remotionTemplate", values: TEMPLATES })}
		{kind === "text" && <label className="block space-y-1"><span>Supporting text</span>
			<input className="bg-background w-full rounded border p-2" value={String(draft.titleContext ?? "")}
				onChange={(event) => change({ key: "titleContext", value: event.target.value || undefined })} /></label>}
		<label className="block space-y-1"><span>Outline width</span><input className="bg-background w-full rounded border p-2"
			type="number" min={0} max={0.02} step={0.001} value={Number(draft.outline ?? 0)}
			onChange={(event) => change({ key: "outline", value: Number(event.target.value) })} /></label>
		{kind === "subtitle" && words.length > 0 && <details><summary className="cursor-pointer font-medium">Timed words ({words.length})</summary>
			<p className="text-muted-foreground py-2">Times are seconds in the source video. Editing a word updates the caption text.</p>
			<div className="space-y-2">{words.map((word, index) => <div key={index} className="grid grid-cols-[1fr_5rem_5rem] gap-2">
				<input aria-label={`Word ${index + 1}`} className="bg-background min-w-0 rounded border p-2" value={word.text}
					onChange={(event) => changeWord({ index, key: "text", value: event.target.value })} />
				<input aria-label={`Word ${index + 1} start`} className="bg-background min-w-0 rounded border p-2" type="number" step={0.01} value={word.start}
					onChange={(event) => changeWord({ index, key: "start", value: Number(event.target.value) })} />
				<input aria-label={`Word ${index + 1} end`} className="bg-background min-w-0 rounded border p-2" type="number" step={0.01} value={word.end}
					onChange={(event) => changeWord({ index, key: "end", value: Number(event.target.value) })} />
			</div>)}</div>
		</details>}
		<button type="button" className="bg-primary text-primary-foreground w-full rounded px-4 py-2"
			onClick={apply}>Apply text style</button>
	</div>;
}
