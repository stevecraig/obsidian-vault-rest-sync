/**
 * 3-way merge algorithm using line-based LCS diff.
 * Pure function, no external dependencies.
 */

export interface ConflictHunk {
	localLines: string[];
	remoteLines: string[];
	ancestorLines: string[];
}

export interface MergeResult {
	merged: string;
	conflicts: ConflictHunk[];
}

/** A hunk describing a range of changed lines relative to the ancestor. */
interface DiffHunk {
	/** Start index in the ancestor (inclusive) */
	ancestorStart: number;
	/** Number of ancestor lines replaced */
	ancestorCount: number;
	/** The replacement lines */
	lines: string[];
}

/**
 * Compute the Longest Common Subsequence table between two arrays of lines.
 * Returns a 2D array where lcs[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0)
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}
	return dp;
}

/**
 * Compute diff hunks between ancestor and modified text.
 * Each hunk describes a contiguous range in the ancestor that was changed.
 */
function computeHunks(ancestor: string[], modified: string[]): DiffHunk[] {
	const dp = lcsTable(ancestor, modified);
	const hunks: DiffHunk[] = [];

	// Backtrack through the LCS table to find matching pairs
	const matches: Array<{ ai: number; bi: number }> = [];
	let i = ancestor.length;
	let j = modified.length;

	while (i > 0 && j > 0) {
		if (ancestor[i - 1] === modified[j - 1]) {
			matches.push({ ai: i - 1, bi: j - 1 });
			i--;
			j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) {
			i--;
		} else {
			j--;
		}
	}

	matches.reverse();

	// Walk through matches to find gaps (hunks of changes)
	let ai = 0;
	let bi = 0;

	for (const m of matches) {
		if (ai < m.ai || bi < m.bi) {
			// There's a gap before this match — that's a hunk
			hunks.push({
				ancestorStart: ai,
				ancestorCount: m.ai - ai,
				lines: modified.slice(bi, m.bi),
			});
		}
		ai = m.ai + 1;
		bi = m.bi + 1;
	}

	// Trailing hunk after last match
	if (ai < ancestor.length || bi < modified.length) {
		hunks.push({
			ancestorStart: ai,
			ancestorCount: ancestor.length - ai,
			lines: modified.slice(bi),
		});
	}

	return hunks;
}

/**
 * Check whether two hunk ranges overlap in the ancestor.
 * Two hunks overlap if they touch or modify the same ancestor region.
 * Zero-length hunks (pure insertions) at the same position also overlap.
 */
function hunksOverlap(a: DiffHunk, b: DiffHunk): boolean {
	const aEnd = a.ancestorStart + a.ancestorCount;
	const bEnd = b.ancestorStart + b.ancestorCount;
	// Two zero-length insertions at the same point overlap
	if (a.ancestorCount === 0 && b.ancestorCount === 0) {
		return a.ancestorStart === b.ancestorStart;
	}
	return a.ancestorStart < bEnd && b.ancestorStart < aEnd;
}

/**
 * 3-way merge using line-based LCS diff.
 * Returns merged content if no overlapping hunks, or conflict info if hunks overlap.
 *
 * @param ancestor - The common ancestor content
 * @param local - The locally modified content
 * @param remote - The remotely modified content
 */
export function merge3(
	ancestor: string,
	local: string,
	remote: string
): MergeResult {
	const ancestorLines = ancestor.split("\n");
	const localLines = local.split("\n");
	const remoteLines = remote.split("\n");

	const localHunks = computeHunks(ancestorLines, localLines);
	const remoteHunks = computeHunks(ancestorLines, remoteLines);

	// Check for overlapping hunks
	const conflicts: ConflictHunk[] = [];
	const overlappingLocal = new Set<number>();
	const overlappingRemote = new Set<number>();

	for (let li = 0; li < localHunks.length; li++) {
		for (let ri = 0; ri < remoteHunks.length; ri++) {
			if (hunksOverlap(localHunks[li], remoteHunks[ri])) {
				overlappingLocal.add(li);
				overlappingRemote.add(ri);
			}
		}
	}

	if (overlappingLocal.size > 0) {
		// Build conflict info for overlapping hunks
		for (const li of overlappingLocal) {
			const lh = localHunks[li];
			// Find all remote hunks that overlap with this local hunk
			const relatedRemoteLines: string[] = [];
			for (const ri of overlappingRemote) {
				const rh = remoteHunks[ri];
				if (hunksOverlap(lh, rh)) {
					relatedRemoteLines.push(...rh.lines);
				}
			}
			conflicts.push({
				localLines: lh.lines,
				remoteLines: relatedRemoteLines,
				ancestorLines: ancestorLines.slice(
					lh.ancestorStart,
					lh.ancestorStart + lh.ancestorCount
				),
			});
		}
		return { merged: "", conflicts };
	}

	// No overlaps — merge both sets of changes into the ancestor.
	// Combine all hunks, sorted by ancestor position (remote first for stable ordering).
	const allHunks: Array<DiffHunk & { source: "local" | "remote" }> = [
		...localHunks.map((h) => ({ ...h, source: "local" as const })),
		...remoteHunks.map((h) => ({ ...h, source: "remote" as const })),
	];

	// Sort by ancestor start position (descending) so we can apply from end to start
	// without shifting indices.
	allHunks.sort((a, b) => b.ancestorStart - a.ancestorStart);

	// Apply hunks to a copy of ancestor lines (from end to start)
	const result = [...ancestorLines];
	for (const hunk of allHunks) {
		result.splice(hunk.ancestorStart, hunk.ancestorCount, ...hunk.lines);
	}

	return { merged: result.join("\n"), conflicts: [] };
}
