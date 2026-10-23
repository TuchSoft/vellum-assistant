import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { SystemPanel } from "./system-panel";

describe("SystemPanel", () => {
  test("renders the six section doors, memory included", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SystemPanel />
      </MemoryRouter>,
    );

    for (const label of [
      "Superpowers",
      "Library",
      "Workspace",
      "Contacts",
      "Channels",
      "Memory",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('href="/assistant/memory"');
  });
});
