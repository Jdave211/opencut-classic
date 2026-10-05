"use client";

import { useEditor } from "@/editor/use-editor";
import { buildTextElement } from "@/timeline/element-utils";
import type { VideoElement } from "@/timeline/types";
import { roundMediaTime } from "@/wasm/media-time-rounding";

const TICKS = 120_000;

export function CenatTextTools({ clip }: { clip: VideoElement }) {
	const editor = useEditor();
	const add = (kind: "text" | "subtitle") => {
		const scene = editor.scenes.getActiveScene();
		const track = scene.tracks.overlay.find((candidate) => candidate.type === "text" && candidate.cenatTextKind === kind);
		if (!track) return;
		const canvas = editor.project.getActive().settings.canvasSize;
		const element = buildTextElement({
			raw: {
				name: kind === "subtitle" ? "Caption" : "Title",
				duration: roundMediaTime({ time: Math.min(clip.duration, 3 * TICKS) }),
				params: {
					content: kind === "subtitle" ? "New caption" : "New title",
					fontFamily: "Arial", fontSize: Math.round(canvas.height * (kind === "subtitle" ? 0.045 : 0.08)),
					"transform.positionY": kind === "subtitle" ? canvas.height * 0.35 : 0,
				},
			},
			startTime: clip.startTime,
		});
		editor.timeline.insertElement({ element: { ...element, cenatTextKind: kind }, placement: { mode: "explicit", trackId: track.id } });
	};
	return <div className="space-y-4 p-4 text-sm">
		<h3 className="font-semibold">Titles and captions</h3>
		<p className="text-muted-foreground">Text now has its own draggable timeline rows. Select a title or caption on the timeline to change its wording, look, motion, and timing.</p>
		<div className="flex gap-2">
			<button type="button" className="bg-primary text-primary-foreground rounded px-3 py-2" onClick={() => add("text")}>Add title</button>
			<button type="button" className="rounded border px-3 py-2" onClick={() => add("subtitle")}>Add caption</button>
		</div>
	</div>;
}
