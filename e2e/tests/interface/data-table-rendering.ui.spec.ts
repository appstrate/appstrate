// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent } from "../../helpers/seed.ts";

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.beforeEach(async ({ apiClient, browserCtx, authedPage: page }) => {
      await createAgent(apiClient, `@${browserCtx.org.orgSlug}`, `second-${Date.now()}`);
      await page.emulateMedia({ colorScheme });
      await page.goto("/agents");
      await expect(page.getByRole("table", { name: "Agents", exact: true })).toBeVisible();
    });

    test("the pinned cells do not add another separator below the first agent", async ({
      authedPage: page,
    }, testInfo) => {
      const row = page
        .getByRole("row")
        .filter({ has: page.getByText("Hello World", { exact: true }) });
      const separators = await row.getByRole("cell").evaluateAll((cells) =>
        cells.map((cell) => {
          const css = getComputedStyle(cell);
          return { border: css.borderBottomWidth, shadow: css.boxShadow };
        }),
      );
      await page.screenshot({ path: testInfo.outputPath("agent-row-separators.png") });
      expect(separators[0]).toEqual(separators[1]);
      expect(separators.at(-1)).toEqual(separators[1]);
    });

    test("all cells change their painted hover background together", async ({
      authedPage: page,
    }) => {
      const row = page
        .getByRole("row")
        .filter({ has: page.getByText("Hello World", { exact: true }) });
      const transitions = await row.evaluate((element) =>
        [element, element.querySelector("td")!, element.querySelector("td:last-child")!].map(
          (part) => {
            const css = getComputedStyle(part);
            return [css.transitionDuration, css.transitionDelay, css.transitionTimingFunction];
          },
        ),
      );
      expect(transitions[1]).toEqual(transitions[0]);
      expect(transitions[2]).toEqual(transitions[0]);
      await page.mouse.move(0, 0);
      for (const hovered of [true, false]) {
        if (hovered) await row.getByRole("cell").nth(2).hover();
        else await page.mouse.move(0, 0);
        const differences = await row.evaluate(async (element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          const painted = (cell: Element) => {
            const layers: Element[] = [];
            for (let layer: Element | null = cell; layer; layer = layer.parentElement)
              layers.push(layer);
            ctx.clearRect(0, 0, 1, 1);
            for (const layer of layers.reverse()) {
              ctx.fillStyle = getComputedStyle(layer).backgroundColor;
              ctx.fillRect(0, 0, 1, 1);
            }
            return [...ctx.getImageData(0, 0, 1, 1).data];
          };
          const cells = [...element.querySelectorAll("td")];
          const samples: number[] = [];
          for (let frame = 0; frame < 12; frame++) {
            await new Promise(requestAnimationFrame);
            const reference = painted(cells[1]!);
            samples.push(
              ...[cells[0]!, cells.at(-1)!].map((cell) =>
                Math.max(
                  ...painted(cell).map((channel, index) => Math.abs(channel - reference[index]!)),
                ),
              ),
            );
          }
          return samples;
        });
        expect(Math.max(...differences)).toBeLessThanOrEqual(1);
      }
    });

    test("resizing and scrolling keep the identity, action and separator intact", async ({
      authedPage: page,
    }, testInfo) => {
      const table = page.getByRole("table", { name: "Agents", exact: true });
      const row = table
        .getByRole("row")
        .filter({ has: page.getByText("Hello World", { exact: true }) });
      const handle = table.getByRole("separator", {
        name: "Redimensionner la colonne Nom",
        exact: true,
      });
      const bounds = await handle.boundingBox();
      expect(bounds).not.toBeNull();
      const x = bounds!.x + bounds!.width / 2;
      const y = bounds!.y + bounds!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 300, y, { steps: 5 });
      await page.mouse.up();
      await page.setViewportSize({ width: 700, height: 900 });
      const scroller = table.locator("..");
      expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      const cells = row.getByRole("cell");
      const before = [await cells.first().boundingBox(), await cells.last().boundingBox()];
      await scroller.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      const after = [await cells.first().boundingBox(), await cells.last().boundingBox()];
      expect(after.map((box) => box!.x)).toEqual(before.map((box) => box!.x));
      await expect(row.getByRole("button", { name: "Lancer", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("agent-row-scrolled.png") });
      await row.getByRole("link", { name: "Hello World", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Hello World", exact: true })).toBeVisible();
    });
  });
}
