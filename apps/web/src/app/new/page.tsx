"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEditor } from "@/editor/use-editor";

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
	"16:9": { width: 1920, height: 1080 },
	"9:16": { width: 1080, height: 1920 },
	"1:1": { width: 1080, height: 1080 },
	"4:5": { width: 1080, height: 1350 },
	"4:3": { width: 1440, height: 1080 },
	"3:4": { width: 1080, height: 1440 },
	"3:2": { width: 1620, height: 1080 },
	"2:3": { width: 1080, height: 1620 },
	"5:4": { width: 1350, height: 1080 },
	"21:9": { width: 2520, height: 1080 },
};

export default function NewProjectPage() {
	const editor = useEditor();
	const router = useRouter();
	const started = useRef(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const returnTo = new URLSearchParams(window.location.search).get("returnTo");
		if (returnTo) {
			try {
				const url = new URL(returnTo);
				if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "5173")
					sessionStorage.setItem("cenat.returnTo", url.origin);
			} catch {
				// Standalone Classic still works if the return address is invalid.
			}
		}
		const aspect = new URLSearchParams(window.location.search).get("aspect") || "16:9";
		void editor.project.loadAllProjects()
			.then(() => editor.project.createNewProject({ name: "Untitled project" }))
			.then(async (id) => {
				const canvasSize = ASPECT_SIZES[aspect];
				if (canvasSize) {
					await editor.project.updateSettings({
						settings: { canvasSize, canvasSizeMode: aspect === "16:9" || aspect === "9:16" || aspect === "1:1" || aspect === "4:3" ? "preset" : "custom" },
						pushHistory: false,
					});
					await editor.save.flush();
				}
				router.replace(`/editor/${id}`);
			})
			.catch((failure) => setError(failure instanceof Error ? failure.message : "Could not create a project."));
	}, [editor.project, router]);

	return (
		<main className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
			<div className="max-w-md text-center">
				<h1 className="text-xl font-semibold">{error ? "Could not open the new editor" : "Opening the new editor…"}</h1>
				{error && <p className="text-muted-foreground mt-3 text-sm">{error}</p>}
			</div>
		</main>
	);
}
