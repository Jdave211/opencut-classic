import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { DEFAULTS } from "@/timeline/defaults";
import { buildTextElement } from "@/timeline/element-utils";
import type { MediaTime } from "@/wasm";
import { roundMediaTime } from "@/wasm/media-time-rounding";
import { getCenatPrimarySession } from "@/lib/cenat-primary";

export function TextView({ defaultKind = "text" }: { defaultKind?: "text" | "subtitle" }) {
	const editor = useEditor();

	const handleAddToTimeline = ({ currentTime, kind = defaultKind }: { currentTime: MediaTime; kind?: "text" | "subtitle" }) => {
		const activeScene = editor.scenes.getActiveScene();
		if (!activeScene) return;
		const cenat = getCenatPrimarySession();
		const canvas = editor.project.getActive().settings.canvasSize;
		const available = editor.timeline.getTotalDuration() - currentTime;
		if (cenat && available <= 0) return;

		const element = buildTextElement({
			raw: cenat ? { name: kind === "subtitle" ? "Caption" : "Title",
				duration: roundMediaTime({ time: Math.min(available, 3 * 120_000) }),
				params: { content: kind === "subtitle" ? "New caption" : "New title", fontFamily: "Arial",
					fontSize: Math.round(canvas.height * (kind === "subtitle" ? 0.045 : 0.08)),
					"transform.positionY": kind === "subtitle" ? canvas.height * 0.35 : 0 } } : DEFAULTS.text.element,
			startTime: currentTime,
		});
		const track = cenat ? activeScene.tracks.overlay.find((candidate) => candidate.type === "text" && candidate.cenatTextKind === kind) : undefined;
		editor.timeline.insertElement({
			element: cenat ? { ...element, cenatTextKind: kind } : element,
			placement: track ? { mode: "explicit", trackId: track.id } : { mode: "auto" },
		});
	};

	return (
		<PanelView title={defaultKind === "subtitle" ? "Captions" : "Text"}>
			<DraggableItem
				name={getCenatPrimarySession() ? (defaultKind === "subtitle" ? "New caption" : "New title") : "Default text"}
				preview={
					<div className="bg-accent flex size-full items-center justify-center rounded">
						<span className="text-xs select-none">{getCenatPrimarySession() ? (defaultKind === "subtitle" ? "New caption" : "New title") : "Default text"}</span>
					</div>
				}
				dragData={{
					id: "temp-text-id",
					type: DEFAULTS.text.element.type,
					name: getCenatPrimarySession() ? (defaultKind === "subtitle" ? "Caption" : "Title") : DEFAULTS.text.element.name,
					content: getCenatPrimarySession() ? (defaultKind === "subtitle" ? "New caption" : "New title") : "Default text",
					...(getCenatPrimarySession() ? { cenatTextKind: defaultKind,
						fontSize: Math.round(editor.project.getActive().settings.canvasSize.height * (defaultKind === "subtitle" ? 0.045 : 0.08)) } : {}),
				}}
				aspectRatio={1}
				onAddToTimeline={({ currentTime }) => handleAddToTimeline({ currentTime, kind: defaultKind })}
				shouldShowLabel={false}
			/>
			{getCenatPrimarySession() && <button type="button" className="mt-3 w-full rounded border px-3 py-2 text-sm"
				onClick={() => handleAddToTimeline({ currentTime: editor.playback.getCurrentTime(), kind: defaultKind })}>Add {defaultKind === "subtitle" ? "caption" : "title"} at playhead</button>}
		</PanelView>
	);
}
