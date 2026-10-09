import { describe, expect, it } from "vitest";

import type { EdgeRecord } from "../src/domain/impact.js";
import { impact } from "../src/domain/impact.js";
import { entryPath, extractLinks, internalPath } from "../src/domain/links.js";

const SITE = "https://example.com";

describe("internalPath", () => {
	it("treats relative and same-origin links as internal and normalises them", () => {
		expect(internalPath("/posts/a/", "/", SITE)).toBe("/posts/a");
		expect(internalPath("b", "/posts/a", SITE)).toBe("/posts/b");
		expect(internalPath("https://EXAMPLE.com:443/x#top", "/", SITE)).toBe("/x");
		expect(internalPath("/search?q=1", "/", SITE)).toBe("/search?q=1");
		expect(internalPath("//double//slash/", "/", SITE)).toBeNull(); // protocol-relative to another host
	});

	it("rejects external, unsafe and fragment-only links", () => {
		expect(internalPath("https://other.com/x", "/", SITE)).toBeNull();
		expect(internalPath("javascript:alert(1)", "/", SITE)).toBeNull();
		expect(internalPath("mailto:a@b.c", "/", SITE)).toBeNull();
		expect(internalPath("#section", "/", SITE)).toBeNull();
		expect(internalPath("http://[bad", "/", SITE)).toBeNull();
	});

	it("only accepts relative links when the site URL is unknown", () => {
		expect(internalPath("/about", "/", "")).toBe("/about");
		expect(internalPath("https://example.com/about", "/", "")).toBeNull();
	});
});

describe("extractLinks", () => {
	it("finds Portable Text link marks at any depth and url fields, ignoring URL-looking text", () => {
		const data = {
			title: "See https://example.com/not-a-link",
			body: [{ _type: "block", markDefs: [{ _type: "link", _key: "k", href: "/a" }], children: [] }],
			sections: [{ items: [{ cta: { _type: "link", href: " /b " } }] }],
			website: "https://example.com/c",
		};
		expect(extractLinks(data, ["website"])).toEqual([
			{ href: "https://example.com/c", field: "website", path: "website" },
			{ href: "/a", field: "body", path: "body[0].markDefs[0]" },
			{ href: "/b", field: "sections", path: "sections[0].items[0].cta" },
		]);
	});

	it("survives empty and hostile input", () => {
		const deep: Record<string, unknown> = {};
		let cur = deep;
		for (let i = 0; i < 100; i++) cur = (cur.next = {}) as Record<string, unknown>;
		expect(extractLinks({ a: null, b: 3, c: deep, d: { _type: "link", href: "" } })).toEqual([]);
	});
});

describe("entryPath", () => {
	it("mirrors EmDash's URL pattern rules and refuses patterns it can't resolve", () => {
		expect(entryPath("/posts/{slug}", "posts", "hello world", "1")).toBe("/posts/hello%20world");
		expect(entryPath(null, "pages", "about", "1")).toBe("/pages/about");
		expect(entryPath("/{slug}/", "pages", "about", "1")).toBe("/about");
		expect(entryPath("/blog/{year}/{slug}", "posts", "a", "1")).toBeNull();
	});
});

describe("impact", () => {
	const e = (source: string, relation: EdgeRecord["relation"], target: string, provenance: EdgeRecord["provenance"] = "DISCOVERED"): EdgeRecord => ({
		id: `${source}|${relation}|${target}`,
		sourceNodeId: source,
		targetNodeId: target,
		relation,
		provenance,
		active: true,
		firstSeenAt: "",
		lastSeenAt: "",
		schemaVersion: 1,
	});
	// A links to B's URL; B links to A's URL (a cycle); C links to B; a form on B is inferred to feed a CRM.
	const graph = [
		e("A", "PUBLISHES_AS", "uA"),
		e("B", "PUBLISHES_AS", "uB"),
		e("C", "PUBLISHES_AS", "uC"),
		e("A", "LINKS_TO", "uB"),
		e("B", "LINKS_TO", "uA"),
		e("C", "LINKS_TO", "uB"),
		e("D", "PUBLISHES_AS", "uD"),
		e("D", "LINKS_TO", "uC"),
		e("form", "PART_OF", "B", "DOCUMENTED"),
		e("form", "SUBMITS_TO", "crm", "INFERRED"),
	];
	const fetch = async (ids: string[], dir: "inbound" | "outbound") =>
		graph.filter((edge) => ids.includes(dir === "outbound" ? edge.sourceNodeId : edge.targetNodeId));

	it("reaches pages linking to an entry without spending a hop on its URL, and stops at cycles", async () => {
		const result = await impact("B", "inbound", 1, fetch);
		const byId = new Map(result.hits.map((h) => [h.nodeId, h]));
		expect([...byId.keys()].sort()).toEqual(["A", "C", "form", "uB"]);
		expect(byId.get("A")?.depth).toBe(1);
		expect(byId.get("A")?.path.map((p) => p.relation)).toEqual(["PUBLISHES_AS", "LINKS_TO"]);
		expect(result.truncated).toBe(false);
	});

	it("respects depth, clamps it to 3, and keeps inferred paths unconfirmed", async () => {
		const two = await impact("B", "inbound", 2, fetch);
		expect(two.hits.map((h) => h.nodeId)).toContain("D");
		const huge = await impact("B", "both", 99, fetch);
		expect(Math.max(...huge.hits.map((h) => h.depth))).toBeLessThanOrEqual(3);
		const crm = huge.hits.find((h) => h.nodeId === "crm");
		expect(crm?.confirmed).toBe(false);
		expect(huge.hits.find((h) => h.nodeId === "A")?.confirmed).toBe(true);
	});
});
