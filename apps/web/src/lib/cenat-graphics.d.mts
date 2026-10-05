export type CenatPrimitive =
	| { t: "stroke"; subpaths: number[][][]; width: number; color: string; cap?: CanvasLineCap; dash?: number[]; alpha?: number }
	| { t: "disc"; cx: number; cy: number; r: number; color: string; alpha?: number }
	| { t: "badge"; x: number; y: number; w: number; h: number; radius: number; color: string; label: string; labelColor: string; fontSize: number; alpha?: number };

export function graphicPrimitives(
	layer: Record<string, unknown>,
	canvas: { w: number; h: number },
	progress: number,
): CenatPrimitive[];
