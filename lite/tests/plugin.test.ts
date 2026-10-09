// End-to-end tests through EmDash's real sandbox (workerd): fixtures, production content
// actions (which fire our hooks), and the admin pages exactly as the host calls them.

import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

type Host = Awaited<ReturnType<typeof createPluginRuntimeTestHost>>;
let host: Host | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

const body = (...links: string[]) => [
	{
		_type: "block",
		_key: "b1",
		style: "normal",
		markDefs: links.map((href, i) => ({ _type: "link", _key: `l${i}`, href })),
		children: [{ _type: "span", _key: "s1", text: "Read more", marks: links.map((_, i) => `l${i}`) }],
	},
];

const text = (response: { blocks: unknown[]; toast?: unknown }) => JSON.stringify(response);

async function site() {
	host = await createPluginRuntimeTestHost({ site: { url: "https://example.com", locale: "en" } });
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		urlPattern: "/posts/{slug}",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "portableText" },
		],
	});
	const pricing = await host.fixtures.content("posts", {
		slug: "pricing",
		status: "published",
		data: { title: "Pricing", content: body("/posts/signup", "/posts/gone", "/", "https://other.com/x") },
	});
	const signup = await host.fixtures.content("posts", {
		slug: "signup",
		status: "published",
		data: { title: "Sign up", content: body("/posts/pricing/") },
	});
	return { host, pricing, signup };
}

async function scan(h: Host) {
	return h.admin.act("/overview", "scan");
}

describe("SiteGraph Lite", () => {
	it("invites a first scan, then lists broken links with the page to fix", async () => {
		const { host } = await site();
		expect(text(await host.admin.loadPage("/overview"))).toContain("Map your site");

		const after = await scan(host);
		expect(after.toast).toMatchObject({ type: "success" });
		expect(String((after.toast as { message: string }).message)).toContain("Read 2 entries");
		const page = text(after);
		expect(page).toContain("/posts/gone");
		expect(page).toContain("Pricing");
		// The home page and external links are never broken.
		expect(page).not.toContain("https://other.com");
		expect(page).not.toMatch(/"path":"\/"/);

		const widget = text(await host.admin.loadWidget("overview"));
		expect(widget).toContain("Broken internal links");
	});

	it("explores what depends on a page and saves notes, rejecting unsafe doc links", async () => {
		const { host, pricing } = await site();
		await scan(host);
		const nodeId = `content:posts:${pricing.id}`;

		const impact = text(await host.admin.submit("/explore", "explore", { node: nodeId, view: "inbound", depth: "2" }));
		expect(impact).toContain("Sign up");
		expect(impact).toContain("Direct");

		const saved = await host.admin.submit("/explore", `note:${nodeId}`, {
			description: "Where plans are sold",
			criticality: "HIGH",
			notes: "",
			docUrl: "https://wiki.example.com/pricing",
			checked: true,
		});
		expect(saved.toast).toMatchObject({ type: "success" });
		const node = await host.inspect.storage.get<{ criticality: string; lastVerifiedAt?: string }>("nodes", nodeId);
		expect(node).toMatchObject({ criticality: "HIGH" });
		expect(node?.lastVerifiedAt).toBeTruthy();

		const unsafe = text(await host.admin.submit("/explore", `note:${nodeId}`, { docUrl: "javascript:alert(1)" }));
		expect(unsafe).toContain("Doc links must start with http");

		// Notes survive a rescan.
		await scan(host);
		expect(await host.inspect.storage.get("nodes", nodeId)).toMatchObject({ criticality: "HIGH", description: "Where plans are sold" });
	});

	it("documents a service and relationships, validates them, and deletes cleanly", async () => {
		const { host, signup } = await site();
		await scan(host);

		const added = await host.admin.submit("/document", "add_node", { kind: "SERVICE", name: "HubSpot CRM", description: "", criticality: "CRITICAL" });
		expect(added.toast).toMatchObject({ type: "success" });
		const crm = (await host.inspect.storage.list<{ label: string }>("nodes")).find((n) => n.data.label === "HubSpot CRM")!;

		const vague = text(await host.admin.submit("/document", "add_edge", { from: `content:posts:${signup.id}`, relation: "RELATED_TO", to: crm.id }));
		expect(vague).toContain("needs a description");

		const linked = await host.admin.submit("/document", "add_edge", { from: `content:posts:${signup.id}`, relation: "DEPENDS_ON", to: crm.id });
		expect(text(linked)).toContain("depends on");

		const impact = text(await host.admin.submit("/explore", "explore", { node: crm.id, view: "inbound", depth: "3" }));
		expect(impact).toContain("Sign up");
		expect(impact).toContain("Pricing"); // Pricing links to Sign up, which depends on the CRM.

		const deleted = await host.admin.act("/document", "del_node", { value: crm.id });
		expect(deleted.toast).toMatchObject({ type: "success" });
		const edges = await host.inspect.storage.list<{ provenance: string }>("edges");
		expect(edges.filter((e) => e.data.provenance === "DOCUMENTED")).toHaveLength(0);

		const discovered = (await host.inspect.storage.list<{ provenance: string }>("edges")).find((e) => e.data.provenance === "DISCOVERED")!;
		expect(text(await host.admin.act("/document", "del_edge", { value: discovered.id }))).toContain("Edit the content instead");
	});

	it("keeps the map current from content hooks without a rescan", async () => {
		const { host } = await site();
		await scan(host);
		const created = await host.actions.content.create("posts", { slug: "faq", data: { title: "FAQ", content: body("/posts/missing-page") } });
		if (!created.success) throw new Error(created.error.message);
		const published = await host.actions.content.publish("posts", created.data.item.id);
		if (!published.success) throw new Error(published.error.message);

		// EmDash runs after-save hooks after the response, like a real save; wait for ours.
		const nodeId = `content:posts:${created.data.item.id}`;
		for (let i = 0; i < 50 && !(await host.inspect.storage.get("nodes", "url:/posts/missing-page")); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(await host.inspect.storage.get("nodes", nodeId)).toMatchObject({ label: "FAQ", active: true });
		const overview = text(await host.admin.loadPage("/overview"));
		expect(overview).toContain("/posts/missing-page");
		expect(overview).toContain("FAQ");
	});

	it("rejects malformed admin requests without throwing", async () => {
		const { host } = await site();
		expect(text((await host.transport.invokeRoute("admin", { type: "nope" })) as { blocks: unknown[] })).toContain("didn't look like");
	});
});
