"use client";
/* eslint-disable jsx-a11y/media-has-caption -- Cenat burns captions into the composite video. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useRafLoop } from "@/hooks/use-raf-loop";
import { getCenatPrimarySession } from "@/lib/cenat-primary";
import { needsCenatCompositePreview } from "@/lib/cenat-exact-preview";
import type { TProject } from "@/project/types";
import { TICKS_PER_SECOND } from "@/wasm";

type Request = { key: string; project: TProject };

/** Show Cenat's composite frames in the normal canvas, under native edit handles. */
export function CenatInlinePreview({
	left, top, width, height,
}: { left: number; top: number; width: number; height: number }) {
	const editor = useEditor();
	const project = useEditor((current) => current.project.getActive());
	const isPreviewingTracks = useEditor((current) => current.timeline.isPreviewingTracks());
	const session = getCenatPrimarySession();
	const videoRef = useRef<HTMLVideoElement>(null);
	const pendingRef = useRef<Request | null>(null);
	const desiredKeyRef = useRef<string | null>(null);
	const renderedKeyRef = useRef<string | null>(null);
	const workingRef = useRef(false);
	const mountedRef = useRef(true);
	const [url, setUrl] = useState("");
	const [renderedKey, setRenderedKey] = useState<string | null>(null);
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	const [error, setError] = useState("");

	const request = useMemo<Request | null>(() => {
		if (!session) return null;
		try {
			const canonical = session.toCenatProject({ project });
			return needsCenatCompositePreview(canonical)
				? { key: JSON.stringify(canonical), project } : null;
		} catch {
			return null;
		}
	}, [project, session]);
	const signature = request?.key || null;
	const latestProjectRef = useRef(project);

	const runPending = useCallback(async () => {
		if (!session || workingRef.current) return;
		workingRef.current = true;
		try {
			while (pendingRef.current && mountedRef.current) {
				const next = pendingRef.current;
				pendingRef.current = null;
				if (next.key !== desiredKeyRef.current) continue;
				setBusy(true);
				setProgress(0);
				setError("");
				try {
					const result = await session.preview({ project: next.project, persist: false,
						onProgress: (value) => {
							if (mountedRef.current && desiredKeyRef.current === next.key) setProgress(value);
						} });
					if (mountedRef.current && desiredKeyRef.current === next.key) {
						renderedKeyRef.current = next.key;
						setRenderedKey(next.key);
						setUrl(result);
						setReady(false);
					}
				} catch (cause) {
					if (mountedRef.current && desiredKeyRef.current === next.key)
						setError(cause instanceof Error ? cause.message : "The canvas preview could not be updated.");
				} finally {
					if (mountedRef.current && desiredKeyRef.current === next.key) setBusy(false);
				}
			}
		} finally { workingRef.current = false; }
	}, [session]);

	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);
	useEffect(() => { latestProjectRef.current = project; }, [project]);
	useEffect(() => {
		desiredKeyRef.current = signature;
		if (!signature) {
			pendingRef.current = null;
			return;
		}
		if (signature === renderedKeyRef.current) return;
		const timer = setTimeout(() => {
			pendingRef.current = { key: signature, project: latestProjectRef.current };
			void runPending();
		}, 800);
		return () => clearTimeout(timer);
	}, [signature, runPending]);
	const useExactAudio = Boolean(url && ready && renderedKey === request?.key && !isPreviewingTracks);
	useEffect(() => {
		if (!session) return;
		editor.audio.setExternallyRenderedAudio({ enabled: useExactAudio });
		return () => editor.audio.setExternallyRenderedAudio({ enabled: false });
	}, [editor, session, useExactAudio]);
	useEffect(() => {
		if (!url || ready) return;
		const video = videoRef.current;
		if (!video) return;
		const checkReady = () => {
			if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
			const time = Math.min(editor.playback.getCurrentTime() / TICKS_PER_SECOND,
				Math.max(0, video.duration - 1 / 60));
			if (Math.abs(video.currentTime - time) > 0.025) {
				video.currentTime = time;
				return;
			}
			if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setReady(true);
		};
		checkReady();
		const timer = window.setInterval(checkReady, 250);
		return () => window.clearInterval(timer);
	}, [editor, ready, url]);

	useRafLoop(() => {
		const video = videoRef.current;
		if (!video) return;
		const volume = editor.playback.getVolume();
		if (Math.abs(video.volume - volume) > 0.001) video.volume = volume;
		if (renderedKey !== request?.key || isPreviewingTracks) {
			if (!video.paused) video.pause();
			return;
		}
		if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
		const time = Math.min(editor.playback.getCurrentTime() / TICKS_PER_SECOND,
			Math.max(0, video.duration - 1 / 60));
		const playing = editor.playback.getIsPlaying();
		if (Math.abs(video.currentTime - time) > (playing ? 0.15 : 0.025)) video.currentTime = time;
		if (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
			Math.abs(video.currentTime - time) < 0.05) setReady(true);
		if (playing && video.paused) void video.play().catch(() => {});
		if (!playing && !video.paused) video.pause();
	});

	if (!request) return null;
	const retry = () => {
		renderedKeyRef.current = null;
		setRenderedKey(null);
		setUrl("");
		setReady(false);
		pendingRef.current = request;
		void runPending();
	};
	return <>
		{url && <video key={url} ref={videoRef} src={url} muted={!useExactAudio} playsInline preload="auto" aria-hidden="true"
			className="pointer-events-none absolute block border"
			style={{ left, top, width, height, objectFit: "fill",
				visibility: ready && renderedKey === request.key && !isPreviewingTracks ? "visible" : "hidden" }}
			onLoadedMetadata={(event) => {
				const video = event.currentTarget;
				const time = Math.min(editor.playback.getCurrentTime() / TICKS_PER_SECOND,
					Math.max(0, video.duration - 1 / 60));
				if (time > 0.025) video.currentTime = time;
				else setReady(true);
			}}
			onSeeked={() => setReady(true)}
			onError={() => { setReady(false); setError("The canvas preview could not play."); }} />}
		{(busy || error) && <div className="bg-background/90 absolute right-4 bottom-4 z-40 rounded border px-3 py-2 text-xs shadow-sm"
			role={busy ? "status" : "alert"}>
			{busy ? `Updating preview… ${progress}%` : <>
				<span>Preview unavailable. </span>
				<button type="button" className="underline" onClick={retry}>Retry</button>
			</>}
		</div>}
	</>;
}
