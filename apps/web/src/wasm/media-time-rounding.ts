/** Integer-tick time, matching `MediaTime(i64)` in the Rust time crate. */
export type MediaTime = number & { readonly __mediaTime: unique symbol };

/**
 * Project a fractional value onto the integer-tick lattice. Round half away
 * from zero, matching Rust's `f64::round`, and normalize negative zero.
 */
export function roundMediaTime({ time }: { time: number }): MediaTime {
	const roundedMagnitude = Math.round(Math.abs(time));
	const rounded =
		roundedMagnitude === 0
			? 0
			: time < 0
				? -roundedMagnitude
				: roundedMagnitude;
	if (!Number.isInteger(rounded)) {
		throw new Error(
			`roundMediaTime(): expected an integer tick count, got ${rounded}`,
		);
	}
	return rounded as MediaTime;
}
