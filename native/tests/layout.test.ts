import { describe, expect, it } from "vitest";

import { NODE_H, NODE_W, type Point, relax, seedRing } from "../src/admin/layout.js";

const overlaps = (a: Point, b: Point) => Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H;

function onLine(p: Point, a: Point, b: Point): boolean {
	const vx = b.x - a.x;
	const vy = b.y - a.y;
	const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy);
	if (t <= 0.05 || t >= 0.95) return false;
	return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)) < NODE_H / 2;
}

describe("layout", () => {
	it("expands a crowded neighbourhood without boxes overlapping or sitting on other lines", () => {
		// An existing node A at the centre already links to B, placed directly below it.
		const pos = new Map<string, Point>([
			["A", { x: 0, y: 0 }],
			["B", { x: 0, y: 250 }],
		]);
		const fresh = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];
		const edges = [{ sourceNodeId: "A", targetNodeId: "B" }, ...fresh.map((id) => ({ sourceNodeId: "A", targetNodeId: id }))];
		for (const [id, p] of seedRing({ x: 0, y: 0 }, fresh, pos)) pos.set(id, p);
		// Force a bad start: one new node right on top of B and one on the A–B line.
		pos.set("c1", { x: 0, y: 250 });
		pos.set("c2", { x: 0, y: 120 });

		const out = relax(pos, edges, new Set(fresh));

		expect(out.get("A")).toEqual({ x: 0, y: 0 });
		expect(out.get("B")).toEqual({ x: 0, y: 250 });
		const ids = [...out.keys()];
		for (let i = 0; i < ids.length; i++)
			for (let j = i + 1; j < ids.length; j++) expect(overlaps(out.get(ids[i]!)!, out.get(ids[j]!)!), `${ids[i]} overlaps ${ids[j]}`).toBe(false);
		for (const e of edges)
			for (const id of fresh)
				if (id !== e.targetNodeId && id !== e.sourceNodeId)
					expect(onLine(out.get(id)!, out.get(e.sourceNodeId)!, out.get(e.targetNodeId)!), `${id} on ${e.sourceNodeId}-${e.targetNodeId}`).toBe(false);
	});
});
