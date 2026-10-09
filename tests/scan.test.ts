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
	data: Row;
}

function fakeCtx(entries: Item[]) {
	const kv = new Map<string, unknown>();
	const nodes = fakeCollection();
	const edges = fakeCollection();
	const ctx = {
		plugin: { id: "sitegraph", version: "test" },
		site: { url: "https://example.com", name: "Test", locale: "en" },
		storage: { nodes, edges },
		kv: {
			get: async (k: string) => structuredClone(kv.get(k)) ?? null,
			set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
			delete: async (k: string) => kv.delete(k),
		},
		schema: {
			listCollections: async () => [
				{ slug: "posts", label: "Posts", labelSingular: "Post", urlPattern: "/posts/{slug}", routable: true, titleField: "title", fields: [] },
			],
		},
		content: {
			get: async (_c: string, id: string) => structuredClone(entries.find((e) => e.id === id)) ?? null,
			list: async (_c: string, { limit = 50, cursor }: { limit?: number; cursor?: string }) => {
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
	await startScan(ctx);
	for (let i = 0; i < 100; i++) if ((await scanStep(ctx)).done) return;
	throw new Error("scan never finished");
}

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
});
