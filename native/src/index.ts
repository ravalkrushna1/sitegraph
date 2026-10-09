import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { routes } from "./routes.js";
import { refreshFromHook, retireFromHook } from "./scan.js";
import { STORAGE } from "./store.js";

const ID = "sitegraph";
const VERSION = "0.1.0";
const PACKAGE = "emdash-plugin-sitegraph";
const ADMIN_ENTRY = `${PACKAGE}/admin`;

const PAGES = [{ path: "/", label: "SiteGraph", icon: "graph" }];
const WIDGETS = [{ id: "overview", title: "SiteGraph", size: "half" as const }];

/** Build-time descriptor: register with `emdash({ plugins: [siteGraph()] })`. */
export function siteGraph(): PluginDescriptor {
	return {
		id: ID,
		version: VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: ADMIN_ENTRY,
		adminPages: PAGES,
		adminWidgets: WIDGETS,
	};
}

const entryId = (content: Record<string, unknown>): string | null =>
	typeof content.id === "string" ? content.id : null;

/** Runtime entry. EmDash imports this by name. */
export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: ID,
		version: VERSION,
		// Read-only by design (SPEC D3): no content writes, no network.
		capabilities: ["content:read", "schema:read"],
		storage: STORAGE,
		admin: { entry: ADMIN_ENTRY, pages: PAGES, widgets: WIDGETS },
		// Hooks refresh only the one entry that changed (SPEC D8). They run after the
		// response, so a failure is logged and the next full scan repairs it.
		hooks: {
			"content:afterSave": async (event, ctx) => {
				const id = entryId(event.content);
				if (id) await refreshFromHook(ctx, event.collection, id);
			},
			"content:afterPublish": async (event, ctx) => {
				const id = entryId(event.content);
				if (id) await refreshFromHook(ctx, event.collection, id);
			},
			"content:afterRestore": async (event, ctx) => {
				const id = entryId(event.content);
				if (id) await refreshFromHook(ctx, event.collection, id);
			},
			"content:afterUnpublish": async (event, ctx) => {
				const id = entryId(event.content);
				if (id) await retireFromHook(ctx, event.collection, id);
			},
			"content:afterDelete": async (event, ctx) => {
				await retireFromHook(ctx, event.collection, event.id);
			},
		},
		routes,
	});
}

export default siteGraph;
