"use client";

import { Separator } from "@/components/ui/separator";
import { type Tab, useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "@/subtitles/components/assets-view";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { SoundsView } from "@/sounds/components/assets-view";
import { StickersView } from "@/stickers/components/assets-view";
import { TextView } from "@/text/components/assets-view";
import { EffectsView } from "@/effects/components/assets-view";
import { getCenatPrimarySession } from "@/lib/cenat-primary";
import { useEditor } from "@/editor/use-editor";
import { CenatEditsTab } from "@/components/editor/panels/properties/components/cenat-edits-tab";
import { CenatGraphicTools } from "@/components/editor/panels/properties/components/cenat-graphic-tools";
import { ScrollArea } from "@/components/ui/scroll-area";

function CenatToolView({ section }: { section: "color" | "effects" | "transitions" | "text" | "audio" }) {
	const editor = useEditor();
	const selected = useEditor((current) => current.selection.getSelectedElements());
	useEditor((current) => current.scenes.getActiveSceneOrNull());
	const item = editor.timeline.getElementsWithTracks({ elements: selected })[0];
	if (!item || (item.element.type !== "video" && item.element.type !== "image") || !item.element.cenatEdit)
		return <p className="text-muted-foreground p-4 text-sm">Select a clip on the timeline to edit its {section}.</p>;
	return <ScrollArea className="h-full"><CenatEditsTab key={`${item.element.id}:${section}:${JSON.stringify(item.element.cenatEdit.clip)}`} element={item.element} trackId={item.track.id} section={section} /></ScrollArea>;
}

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();
	const cenat = getCenatPrimarySession();

	const viewMap: Record<Tab, React.ReactNode> = cenat ? {
		media: <MediaView />,
		sounds: <CenatToolView section="audio" />,
		text: <TextView defaultKind="text" />,
	stickers: <CenatGraphicTools />,
		effects: <CenatToolView section="effects" />,
		transitions: <CenatToolView section="transitions" />,
		captions: <TextView defaultKind="subtitle" />,
		adjustment: <CenatToolView section="color" />,
		settings: <SettingsView />,
	} : {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		effects: <EffectsView />,
		transitions: (
			<div className="text-muted-foreground p-4">
				Transitions view coming soon...
			</div>
		),
		captions: <Captions />,
		adjustment: (
			<div className="text-muted-foreground p-4">
				Adjustment view coming soon...
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
