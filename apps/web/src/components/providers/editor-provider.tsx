"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import { CenatPrimarySession } from "@/lib/cenat-primary";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

function importedCenatSourceId(projectId: string): string | null {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem("cenat.importedProjects.v1") || "{}");
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		for (const [key, value] of Object.entries(raw)) {
			const sourceId = key.split(":")[0];
			if (value === projectId && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sourceId)) return sourceId;
		}
	} catch { /* An unrelated browser project can still open normally. */ }
	return null;
}

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [progress, setProgress] = useState("Loading project...");
	const { setLoadingProject } = useKeybindingsStore();

	useEffect(() => {
		setLoadingProject(isLoading);
	}, [isLoading, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async () => {
			let stage = "Starting the editor";
			try {
				setIsLoading(true);
				const params = new URLSearchParams(window.location.search);
				const isCenatProject = params.get("cenat") === "1";
				if (isCenatProject) document.title = "Cenat editor";
				if (!isCenatProject && params.get("standalone") !== "1") {
					const sourceId = importedCenatSourceId(projectId);
					if (sourceId) {
						window.location.replace(`${process.env.NEXT_PUBLIC_CENAT_HOME_URL || "http://localhost:5173"}/editor/${sourceId}`);
						return;
					}
				}
				stage = "Preparing video playback";
				await initializeGpuRenderer();
				editor.renderer.setDegraded(!isGpuAvailable());
				if (isCenatProject) {
					stage = "Opening the Cenat project";
					const loaded = await CenatPrimarySession.open({ id: projectId, onProgress: setProgress });
					if (cancelled) { loaded.session.clear(); return; }
					stage = "Loading project media into the editor";
					editor.project.loadExternalProject({
						project: loaded.project,
						media: loaded.media,
						 save: (project) => loaded.session.save({ project }),
					});
					stage = "Preparing clip previews";
					loaded.session.bindPreview({ editor });
				} else {
					stage = "Opening the browser project";
					await editor.project.loadProject({ id: projectId });
					if (params.get("standalone") !== "1") {
						const importedClips = editor.project.getActive().scenes
							.find((scene) => scene.isMain)?.tracks.main.elements
							.filter((element) => element.type === "video" && element.cenatEdit) || [];
						const importedClip = importedClips[0];
						const sourceAssetId = importedClip?.type === "video" ? importedClip.cenatEdit?.clip.assetId : undefined;
						if (typeof sourceAssetId === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sourceAssetId)) {
							const destination = new URL(process.env.NEXT_PUBLIC_CENAT_HOME_URL || "http://localhost:5173");
							destination.searchParams.set("sourceAsset", sourceAssetId);
							destination.searchParams.set("sourceName", editor.project.getActive().metadata.name);
							const sourceClips = importedClips.flatMap((element) => element.type === "video" && typeof element.cenatEdit?.clip.id === "string" ? [element.cenatEdit.clip.id] : []);
							if (sourceClips.length) destination.searchParams.set("sourceClips", sourceClips.slice(0, 8).join(","));
							window.location.replace(destination.href);
							return;
						}
					}
				}

				if (cancelled) return;

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound && new URLSearchParams(window.location.search).get("cenat") !== "1") {
					try {
						const newProjectId = await editor.project.createNewProject({
							name: "Untitled Project",
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError("Failed to create project");
						setIsLoading(false);
					}
				} else {
					const wasmPanic = (window as Window & { __wasmPanic?: string })
						.__wasmPanic;
					if (wasmPanic) {
						delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
						setError(wasmPanic);
					} else {
						setError(
							err instanceof Error ? `${stage}: ${err.message}` : `Could not load project during ${stage.toLowerCase()}`,
						);
					}
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">{progress}</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">Exiting project...</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			{children}
		</>
	);
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}
