// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"agent-integration.mdx": () => import("../content/docs/agent-integration.mdx?collection=docs"), "browser.mdx": () => import("../content/docs/browser.mdx?collection=docs"), "custom-themes.mdx": () => import("../content/docs/custom-themes.mdx?collection=docs"), "customization.mdx": () => import("../content/docs/customization.mdx?collection=docs"), "diff-viewer.mdx": () => import("../content/docs/diff-viewer.mdx?collection=docs"), "faq.mdx": () => import("../content/docs/faq.mdx?collection=docs"), "first-workspace.mdx": () => import("../content/docs/first-workspace.mdx?collection=docs"), "installation.mdx": () => import("../content/docs/installation.mdx?collection=docs"), "keyboard-shortcuts.mdx": () => import("../content/docs/keyboard-shortcuts.mdx?collection=docs"), "mcp.mdx": () => import("../content/docs/mcp.mdx?collection=docs"), "overview.mdx": () => import("../content/docs/overview.mdx?collection=docs"), "ports.mdx": () => import("../content/docs/ports.mdx?collection=docs"), "setup-teardown-scripts.mdx": () => import("../content/docs/setup-teardown-scripts.mdx?collection=docs"), "terminal-integration.mdx": () => import("../content/docs/terminal-integration.mdx?collection=docs"), "terminal-presets.mdx": () => import("../content/docs/terminal-presets.mdx?collection=docs"), "use-with-ide.mdx": () => import("../content/docs/use-with-ide.mdx?collection=docs"), "using-monorepos.mdx": () => import("../content/docs/using-monorepos.mdx?collection=docs"), "workspaces.mdx": () => import("../content/docs/workspaces.mdx?collection=docs"), }),
};
export default browserCollections;