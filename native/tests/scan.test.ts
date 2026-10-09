import type { PluginContext } from "emdash";
import { beforeEach, describe, expect, it } from "vitest";

import { routes } from "../src/routes.js";
import { refreshFromHook, scanStep, startScan } from "../src/scan.js";

// In-memory stand-ins for EmDash storage, KV and content: just enough of the API we use.
type Row = Record<string, unknown>;
function fakeCollection() {
	const rows = new Map<string, Row>();
	const matches = (data: Row, where: Row = {}) =>
		Object.entries(where).every(([key, cond]) => {
			const value = data[key];
			if (cond && typeof cond === "object" && "in" in cond) return (cond.in as unknown[]).includes(value);
			if (cond && typeof cond === "object" && "startsWith" in cond)
				return typeof value === "string" && value.startsWith(cond.startsWith as string);
			return value === cond;
		});
	return {
		rows,
		get: async (id: string) => structuredClone(rows.get(id)) ?? null,
		getMany: async (ids: string[]) =>
			new Map(ids.filter((id) => rows.has(id)).map((id) => [id, structuredClone(rows.get(id)!)])),
		put: async (id: string, data: Row) => void rows.set(id, structuredClone(data)),
		putMany: async (items: Array<{ id: string; data: Row }>) => items.forEach((i) => rows.set(i.id, structuredClone(i.data))),
		delete: async (id: string) => rows.delete(id),
		deleteMany: async (ids: string[]) => ids.filter((id) => rows.delete(id)).length,
		count: async (where?: Row) => [...rows.values()].filter((d) => matches(d, where)).length,
		query: async ({ where, limit = 50, cursor }: { where?: Row; limit?: number; cursor?: string }) => {
			const all = [...rows].filter(([, d]) => matches(d, where)).sort(([a], [b]) => a.localeCompare(b));
			const start = cursor ? Number(cursor) : 0;
			const items = all.slice(start, start + limit).map(([id, data]) => ({ id, data: structuredClone(data) }));
			const hasMore = start + limit < all.length;
			return { items, hasMore, cursor: hasMore ? String(start + limit) : undefined };
		},
	};
}

interface Item {
	id: string;
	slug: string;
	status: string;
	locale?: string;
	data: Row;
}

const POSTS = { slug: "posts", label: "Posts", labelSingular: "Post", urlPattern: "/posts/{slug}", routable: true, titleField: "title", fields: [] };

function fakeCtx(entries: Item[], collections: unknown[] = [POSTS]) {
	const kv = new Map<string, { value: unknown; revision: string }>();
	let rev = 0;
	const nodes = fakeCollection();
	const edges = fakeCollection();
	const ctx = {
		plugin: { id: "sitegraph", version: "test" },
		site: { url: "https://example.com", name: "Test", locale: "en" },
		log: { info() {}, warn() {}, error() {} },
		storage: { nodes, edges },
		kv: {
			get: async (k: string) => structuredClone(kv.get(k)?.value) ?? null,
			set: async (k: string, v: unknown) => void kv.set(k, { value: structuredClone(v), revision: String(++rev) }),
			delete: async (k: string) => kv.delete(k),
			getVersioned: async (k: string) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
			compareAndSet: async (k: string, expected: string | null, v: unknown) => {
				if ((kv.get(k)?.revision ?? null) !== expected) return { applied: false };
				kv.set(k, { value: structuredClone(v), revision: String(++rev) });
				return { applied: true, revision: String(rev) };
			},
		},
		schema: {
			listCollections: async () => collections,
		},
		content: {
			get: async (_c: string, id: string) => structuredClone(entries.find((e) => e.id === id)) ?? null,
			list: async (c: string, { limit = 50, cursor }: { limit?: number; cursor?: string }) => {
				if (c === "ghost") throw new Error("Collection not found");
				const published = entries.filter((e) => e.status === "published");
				const start = cursor ? Number(cursor) : 0;
				const hasMore = start + limit < published.length;
				return { items: structuredClone(published.slice(start, start + limit)), hasMore, cursor: hasMore ? String(start + limit) : undefined };
			},
		},
	} as unknown as PluginContext;
	return { ctx, nodes, edges };
}

const post = (id: string, links: string[], status = "published"): Item => ({
	id,
	slug: id,
	status,
	data: {
		title: `Post ${id.toUpperCase()}`,
		content: [{ _type: "block", markDefs: links.map((href, i) => ({ _type: "link", _key: String(i), href })), children: [] }],
	},
});

async function fullScan(ctx: PluginContext) {
	const { id } = await startScan(ctx);
	for (let i = 0; i < 100; i++) if ((await scanStep(ctx, id)).done) return;
	throw new Error("scan never finished");
}

const broken = async (ctx: PluginContext) =>
	((await call(routes.overview, ctx, undefined)) as { brokenLinks: number }).brokenLinks;

const call = <T>(route: { handler: (ctx: never) => Promise<T> }, ctx: PluginContext, input: unknown) =>
	route.handler({ ...ctx, input } as never);

describe("scan", () => {
	let entries: Item[];
	beforeEach(() => {
		entries = [post("a", ["/posts/b", "https://example.com/posts/missing", "https://other.com"]), post("b", ["/posts/a/"])];
	});

	it("maps entries, their URLs and internal links, and flags links to pages that don't exist", async () => {
		const { ctx, nodes, edges } = fakeCtx(entries);
		await fullScan(ctx);
		expect(nodes.rows.get("content:posts:a")).toMatchObject({ type: "CONTENT", label: "Post A", active: true });
		expect(nodes.rows.get("url:/posts/b")).toMatchObject({ resolved: true });
		expect(nodes.rows.get("url:/posts/missing")).toMatchObject({ resolved: false, active: true });
		expect([...nodes.rows.keys()].some((k) => k.includes("other.com"))).toBe(false);
		expect(edges.rows.get("content:posts:a|LINKS_TO|url:/posts/b|content")).toMatchObject({
			provenance: "DISCOVERED",
			evidence: { fieldPath: "content[0].markDefs[0]", href: "/posts/b" },
		});
		const overview = (await call(routes.overview, ctx, undefined)) as { brokenLinks: number };
		expect(overview.brokenLinks).toBe(1);
	});

	it("keeps human annotations and documented edges through rescans", async () => {
		const { ctx, edges } = fakeCtx(entries);
		await fullScan(ctx);
		await call(routes["nodes/save"], ctx, { id: "content:posts:b", criticality: "HIGH", notes: "Pricing page" });
		const crm = (await call(routes["nodes/save"], ctx, { type: "SERVICE", label: "HubSpot" })) as { id: string };
		await call(routes["edges/save"], ctx, { sourceNodeId: "content:posts:b", targetNodeId: crm.id, relation: "DEPENDS_ON" });

		await fullScan(ctx);
		const { nodes } = ctx.storage as unknown as { nodes: ReturnType<typeof fakeCollection> };
		expect(nodes.rows.get("content:posts:b")).toMatchObject({ criticality: "HIGH", notes: "Pricing page", active: true });
		expect([...edges.rows.values()].filter((e) => e.provenance === "DOCUMENTED" && e.active)).toHaveLength(1);

		const hit = (await call(routes["graph/impact"], ctx, { nodeId: crm.id, direction: "inbound", depth: 2 })) as {
			hits: Array<{ nodeId: string }>;
		};
		// HubSpot ← post B ← (B's URL) ← post A, which links to B.
		expect(hit.hits.map((h) => h.nodeId)).toEqual(expect.arrayContaining(["content:posts:b", "content:posts:a"]));
	});

	it("retires a link removed by an edit, and an entry deleted between scans", async () => {
		const { ctx, nodes, edges } = fakeCtx(entries);
		await fullScan(ctx);

		entries[0] = post("a", []);
		await refreshFromHook(ctx, "posts", "a");
		expect(edges.rows.get("content:posts:a|LINKS_TO|url:/posts/b|content")).toMatchObject({ active: false });

		entries.splice(1, 1);
		await fullScan(ctx);
		expect(nodes.rows.get("content:posts:b")).toMatchObject({ active: false });
	});

	it("never retires anything when the scan had failures", async () => {
		const { ctx, nodes } = fakeCtx(entries);
		await fullScan(ctx);
		entries.splice(1, 1);
		entries[0]!.data = null as unknown as Row; // makes refreshing A throw
		await fullScan(ctx);
		expect(nodes.rows.get("content:posts:b")).toMatchObject({ active: true });
		const { scan } = (await call(routes.overview, ctx, undefined)) as { scan: { last: { status: string } } };
		expect(scan.last.status).toBe("PARTIAL");
	});

	it("keeps a renamed page's old URL broken while something still links to it, even if hooks were missed", async () => {
		const { ctx, nodes } = fakeCtx(entries);
		await fullScan(ctx);
		expect(nodes.rows.get("url:/posts/b")).toMatchObject({ resolved: true });

		// Hook path: B is renamed; A still links to /posts/b.
		entries[1] = { ...entries[1]!, slug: "b2" };
		await refreshFromHook(ctx, "posts", "b");
		expect(nodes.rows.get("url:/posts/b")).toMatchObject({ resolved: false, active: true });
		expect(await broken(ctx)).toBe(2);

		// Missed-hook path: rename back with no hook; a full scan alone must repair both URLs.
		entries[1] = { ...entries[1]!, slug: "b" };
		await fullScan(ctx);
		expect(nodes.rows.get("url:/posts/b")).toMatchObject({ resolved: true });
		expect(nodes.rows.get("url:/posts/b2")).toMatchObject({ active: false });
		expect(await broken(ctx)).toBe(1);
	});

	it("only calls a link broken when an entry could live there", async () => {
		entries.push(post("c", ["/", "/rss.xml", "/posts/b?ref=nav", "/category/news", "/posts/ghost"]));
		const { ctx, nodes } = fakeCtx(entries);
		await fullScan(ctx);
		expect(nodes.rows.get("url:/")).toMatchObject({ active: true });
		expect(nodes.rows.get("url:/")?.resolved).toBeUndefined();
		expect(nodes.rows.get("url:/rss.xml")?.resolved).toBeUndefined();
		expect(nodes.rows.get("url:/category/news")?.resolved).toBeUndefined();
		expect(nodes.rows.has("url:/posts/b?ref=nav")).toBe(false);
		expect(nodes.rows.get("url:/posts/ghost")).toMatchObject({ resolved: false });
		expect(await broken(ctx)).toBe(2); // /posts/missing and /posts/ghost
	});

	it("doesn't count a page nobody links to as broken when it's unpublished", async () => {
		entries.push(post("lonely", []));
		const { ctx, nodes } = fakeCtx(entries);
		await fullScan(ctx);
		entries[2] = { ...entries[2]!, status: "draft" };
		await refreshFromHook(ctx, "posts", "lonely");
		expect(nodes.rows.get("url:/posts/lonely")).toMatchObject({ active: false });
		expect(nodes.rows.get("content:posts:lonely")).toMatchObject({ active: false });
		expect(await broken(ctx)).toBe(1);
	});

	it("maps translations as entries without guessing their URL", async () => {
		entries.push({ ...post("fr", []), locale: "fr", slug: "b" });
		const { ctx, nodes, edges } = fakeCtx(entries);
		await fullScan(ctx);
		expect(nodes.rows.get("content:posts:fr")).toMatchObject({ active: true });
		expect([...edges.rows.keys()].some((k) => k.startsWith("content:posts:fr|PUBLISHES_AS"))).toBe(false);
		expect(nodes.rows.get("url:/posts/b")).toMatchObject({ resolved: true });
	});

	it("skips a collection that can't be listed, and refuses to advance a replaced scan", async () => {
		const ghost = { ...POSTS, slug: "ghost" };
		const { ctx } = fakeCtx(entries, [ghost, POSTS]);
		const first = await startScan(ctx);
		const { state } = await scanStep(ctx, first.id); // ghost fails; the scan moves on instead of sticking
		expect(state?.index).toBe(1);
		expect(state?.errors[0]).toContain("ghost");
		await expect(scanStep(ctx, "scan_someone_else")).rejects.toThrow(/newer scan/);
	});
});
