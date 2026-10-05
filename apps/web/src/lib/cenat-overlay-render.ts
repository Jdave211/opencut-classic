import { graphicPrimitives, type CenatPrimitive } from "./cenat-graphics.mjs";

export type CenatVisualOverlay = Record<string, unknown>;

const STICKER_PATHS: Record<string, string> = {
	star: "M50 4 61 35 95 35 68 56 78 89 50 69 22 89 32 56 5 35 39 35Z",
	heart: "M50 87 13 51C-10 23 27 1 50 27 73 1 110 23 87 51Z",
	arrow: "M8 39H58V14L95 50 58 86V61H8Z",
	sparkle: "M50 2 63 37 98 50 63 63 50 98 37 63 2 50 37 37Z",
	circle: "M50 5A45 45 0 1 0 50 95A45 45 0 1 0 50 5Z",
};

function number({ value, fallback }: { value: unknown; fallback: number }): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function drawPrimitives({ ctx, primitives }: { ctx: OffscreenCanvasRenderingContext2D; primitives: CenatPrimitive[] }) {
	for (const primitive of primitives) {
		ctx.save();
		ctx.globalAlpha *= primitive.alpha ?? 1;
		if (primitive.t === "stroke") {
			ctx.strokeStyle = primitive.color;
			ctx.lineWidth = primitive.width;
			ctx.lineCap = primitive.cap || "round";
			ctx.lineJoin = "round";
			ctx.setLineDash(primitive.dash || []);
			for (const points of primitive.subpaths) {
				if (points.length < 2) continue;
				ctx.beginPath();
				ctx.moveTo(points[0][0], points[0][1]);
				for (let index = 1; index < points.length; index++) ctx.lineTo(points[index][0], points[index][1]);
				ctx.stroke();
			}
		} else if (primitive.t === "disc") {
			ctx.fillStyle = primitive.color;
			ctx.beginPath();
			ctx.arc(primitive.cx, primitive.cy, Math.max(0, primitive.r), 0, Math.PI * 2);
			ctx.fill();
		} else {
			ctx.shadowColor = "rgba(0,0,0,0.35)";
			ctx.shadowBlur = primitive.h * 0.18;
			ctx.shadowOffsetY = primitive.h * 0.08;
			ctx.fillStyle = primitive.color;
			ctx.beginPath();
			ctx.roundRect(primitive.x, primitive.y, primitive.w, primitive.h, primitive.radius);
			ctx.fill();
			ctx.shadowColor = "transparent";
			ctx.fillStyle = primitive.labelColor;
			ctx.font = `800 ${primitive.fontSize}px "Albert Sans", "Arial"`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(primitive.label, primitive.x + primitive.w / 2,
				primitive.y + primitive.h / 2 + primitive.fontSize * 0.04);
		}
		ctx.restore();
	}
}

/** Render source-timed Cenat stickers and hand-drawn graphics as native timeline visuals. */
export function renderCenatOverlay({
	overlay, canvasSize, elapsedSeconds, remainingSeconds,
}: {
	overlay: CenatVisualOverlay;
	canvasSize: { width: number; height: number };
	elapsedSeconds: number;
	remainingSeconds: number;
}): OffscreenCanvas {
	const canvas = new OffscreenCanvas(canvasSize.width, canvasSize.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not draw a visual overlay.");
	const { width: w, height: h } = canvasSize;
	const kind = String(overlay.kind);
	const animation = String(overlay.animation || (kind === "graphic" ? "draw" : "none"));
	const exit = String(overlay.exitAnimation || animation);
	const phase = Math.min(elapsedSeconds, remainingSeconds);
	const motionDuration = kind === "graphic" ? animation === "draw" ? 0.6 : 0.3
		: animation === "bounce" ? 0.7 : animation === "pop" ? 0.4 : 0.35;
	const progress = Math.max(0, Math.min(1, phase / Math.max(0.01, motionDuration)));
	const eased = 1 - (1 - progress) ** 2;
	const x = number({ value: overlay.x, fallback: 0.5 }) * w;
	const y = number({ value: overlay.y, fallback: 0.5 }) * h;
	const size = number({ value: overlay.size, fallback: kind === "graphic" ? 0.16 : 0.15 }) * h;
	ctx.save();
	if (kind === "sticker") {
		const entrance = elapsedSeconds < motionDuration ? animation : remainingSeconds < motionDuration ? exit : "none";
		if (entrance === "fade" || entrance === "appear") ctx.globalAlpha = eased;
		if (entrance.startsWith("slide-") || entrance === "rise") {
			const distance = (1 - eased) * h * 0.08;
			ctx.translate(entrance === "slide-left" ? distance : entrance === "slide-right" ? -distance : 0,
				entrance === "slide-down" ? -distance : distance);
			ctx.globalAlpha = eased;
		}
		if (["pop", "bounce", "stamp", "zoom-blur"].includes(entrance)) {
			const scale = entrance === "bounce" ? 0.4 + 0.6 * (1 - Math.cos(progress * Math.PI * 1.5) * (1 - progress))
				: 0.5 + 0.5 * eased;
			ctx.translate(x, y);
			ctx.scale(scale, scale);
			ctx.translate(-x, -y);
			ctx.globalAlpha = eased;
		}
		const path = STICKER_PATHS[String(overlay.sticker || "star")];
		if (path) {
			ctx.translate(x - size / 2, y - size / 2);
			ctx.scale(size / 100, size / 100);
			ctx.fillStyle = String(overlay.color || "#ffffff");
			ctx.fill(new Path2D(path));
		}
	} else if (kind === "graphic") {
		drawPrimitives({ ctx, primitives: graphicPrimitives(overlay, { w, h }, progress) });
	}
	ctx.restore();
	return canvas;
}
