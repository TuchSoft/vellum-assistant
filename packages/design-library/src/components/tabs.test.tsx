import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Tabs, type TabsPlacement, type TabsVariant } from "./tabs";

function markup(placement?: TabsPlacement, variant?: TabsVariant) {
  return renderToStaticMarkup(
    <Tabs.Root defaultValue="overview">
      <Tabs.Panel value="overview">Overview panel</Tabs.Panel>
      <Tabs.Panel value="activity">Activity panel</Tabs.Panel>
      <Tabs.List placement={placement} variant={variant}>
        <Tabs.Trigger value="overview" variant={variant}>
          Overview
        </Tabs.Trigger>
        <Tabs.Trigger value="activity" variant={variant}>
          Activity
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>,
  );
}

function classesOf(html: string, slot: string): string[] {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  expect(tag).not.toBeNull();
  const classAttr = tag?.[0].match(/class="([^"]*)"/);
  expect(classAttr).not.toBeNull();
  return (classAttr?.[1] ?? "").split(" ");
}

describe("Tabs.List placement", () => {
  test("a list defaults to the top edge and rules under its row", () => {
    const html = markup();
    expect(html).toContain('data-placement="top"');
    const classes = classesOf(html, "tabs-list");
    expect(classes).toContain("border-b");
    expect(classes).not.toContain("border-t");
  });

  test("a bottom-placed list rules over its row", () => {
    const html = markup("bottom");
    expect(html).toContain('data-placement="bottom"');
    const classes = classesOf(html, "tabs-list");
    expect(classes).toContain("border-t");
    expect(classes).not.toContain("border-b");
  });

  test("a trigger reads its list's placement for the active indicator", () => {
    const classes = classesOf(markup(), "tabs-trigger");
    expect(classes).toContain(
      "group-data-[placement=bottom]/tabs-list:border-t-2",
    );
  });
});

describe("Tabs.List variant", () => {
  test("a list defaults to the underline variant", () => {
    expect(markup()).toContain('data-variant="underline"');
  });

  test("a pills list drops the rule and spaces its chips", () => {
    const html = markup(undefined, "pills");
    expect(html).toContain('data-variant="pills"');
    const classes = classesOf(html, "tabs-list");
    expect(classes).toContain("gap-1");
    expect(classes).not.toContain("border-b");
  });

  test("a pills trigger carries the rounded chip treatment", () => {
    const classes = classesOf(markup(undefined, "pills"), "tabs-trigger");
    expect(classes).toContain("rounded-full");
    expect(classes).not.toContain("border-b-2");
  });
});
