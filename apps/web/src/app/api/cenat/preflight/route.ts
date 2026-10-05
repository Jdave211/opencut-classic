import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
// The compatibility checker also powers the offline CLI used for review.
import { analyzeCenatProject } from "../../../../../../../scripts/cenat-compatibility.mjs";

export const runtime = "nodejs";

export async function POST(request: Request) {
	try {
		const payload = await request.json();
		if (typeof payload?.source !== "string" || !Array.isArray(payload?.assets))
			return NextResponse.json({ error: "Invalid Cenat handoff." }, { status: 400 });
		const source = JSON.parse(payload.source);
		const mediaSizes = new Map<string, number>(
			payload.assets.map((asset: { id: string; bytes: number }) => [asset.id, asset.bytes]),
		);
		const report = analyzeCenatProject({
			source,
			assets: payload.assets,
			mediaSizes,
			sourceHash: createHash("sha256").update(payload.source).digest("hex"),
		});
		return NextResponse.json(report);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Preflight failed." },
			{ status: 400 },
		);
	}
}
