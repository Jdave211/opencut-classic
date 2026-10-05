"use client";

import { useEditor } from "@/editor/use-editor";
import { buildStickerElement } from "@/timeline/element-utils";
import type { ImageElement, VideoElement } from "@/timeline/types";
import { roundMediaTime } from "@/wasm/media-time-rounding";

const TICKS = 120_000;
const STICKERS = ["star", "heart", "arrow", "sparkle", "circle"];
const GRAPHICS = ["arrow", "curve", "loop", "line", "disc", "badge"];

export function CenatGraphicTools() {
	const editor = useEditor();
	const selected = useEditor((current) => current.selection.getSelectedElements());
	const clip = editor.timeline.getElementsWithTracks({ elements: selected })
		.map(({ element }) => element)
		.find((element): element is VideoElement | ImageElement =>
			(element.type === "video" || element.type === "image") && !!element.cenatEdit);
	const add = ({ kind, id }: { kind: "sticker" | "graphic"; id: string }) => {
		const scene = editor.scenes.getActiveScene();
		const track = scene.tracks.overlay.find((row) => row.type === "graphic" && row.cenatGraphicLane === 0);
		if (!track) return;
		const now = editor.playback.getCurrentTime();
		const target = clip || scene.tracks.main.elements.find((element) => now >= element.startTime && now < element.startTime + element.duration);
		if (!target?.cenatEdit) return;
		const startTime = roundMediaTime({ time: now >= target.startTime && now < target.startTime + target.duration
			? now : target.startTime });
		const remaining = target.startTime + target.duration - startTime;
		const canvas = editor.project.getActive().settings.canvasSize;
		const element = buildStickerElement({ stickerId: "shapes:star", name: `${id} ${kind}`,
			startTime, intrinsicWidth: canvas.width, intrinsicHeight: canvas.height });
		editor.timeline.insertElement({ element: {
			...element, duration: roundMediaTime({ time: Math.min(remaining, 3 * TICKS) }),
			cenatOverlaySourceRate: Number(target.cenatEdit.clip.speed || 1),
			cenatOverlayStyle: {
				kind, ...(kind === "sticker" ? { sticker: id } : { graphic: id, x2: 0.7, y2: 0.62,
					animation: id === "disc" || id === "badge" ? "pop" : "draw" }),
				x: 0.5, y: 0.5, size: kind === "sticker" ? 0.15 : 0.16,
				color: kind === "graphic" ? "#ff3b30" : "#ffffff", background: false,
			},
		}, placement: { mode: "explicit", trackId: track.id } });
	};
	const options = ({ kind, ids }: { kind: "sticker" | "graphic"; ids: string[] }) => <div className="grid grid-cols-3 gap-2">
		{ids.map((id) => <button type="button" key={id} className="rounded border px-2 py-3 text-left capitalize hover:bg-accent"
			onClick={() => add({ kind, id })}>{id}</button>)}
	</div>;
	return <div className="space-y-5 p-4 text-sm">
		<h3 className="font-semibold">Stickers & graphics</h3>
		<p className="text-muted-foreground">Add a visual at the playhead. Select it on the timeline to change its look or timing.</p>
		<div className="space-y-2"><h4 className="font-medium">Stickers</h4>{options({ kind: "sticker", ids: STICKERS })}</div>
		<div className="space-y-2"><h4 className="font-medium">Graphics</h4>{options({ kind: "graphic", ids: GRAPHICS })}</div>
	</div>;
}
