// SPDX-License-Identifier: Apache-2.0

/** Read-only package IA checks. Uses the lab, never a real OAuth provider. */
import { chromium, expect } from "@playwright/test";

const base = process.env.LAB_URL ?? "http://localhost:5302";
// Desktop iterations by default; the final responsive pass opts into more widths.
const widths = (process.env.LAB_WIDTHS ?? "1440").split(",").map(Number);
const browser = await chromium.launch({ channel: "chrome" });
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("[lab] no fixture")) failures.push(message.text());
  });
  const open = async (path) => {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main [role=tablist]")).toBeVisible();
  };
  const skill = "/skills/@tractr/compta-references";
  const integration = "/integrations/@appstrate/google-drive";

  await open(skill);
  await expect(page.getByTestId("package-overview")).toContainText("Instructions");
  await expect(page.getByTestId("package-overview")).not.toContainText(
    "Ce manifest ne déclare aucune métadonnée",
  );
  await page.getByRole("button", { name: "Lire les instructions complètes", exact: true }).click();
  await expect(page).toHaveURL(/#content$/);
  await expect(page.getByPlaceholder("Rechercher un fichier…")).toBeVisible();
  await open(`${skill}#versions`);
  await page.getByRole("link", { name: "1.4.0", exact: true }).click();
  await expect(page).toHaveURL(/\/1\.4\.0$/);
  await expect(page.getByTestId("package-overview")).toBeVisible();

  await open("/mcp-servers/@appstrate/gdrive-mcp");
  await expect(page.getByTestId("package-overview")).toContainText("drive_search");
  await open(integration);
  await expect(page.getByTestId("integration-overview")).toContainText("Prête à connecter");
  await expect(page.getByTestId("integration-overview").getByRole("heading")).toHaveText([
    "État de l’intégration",
    "Méthodes de connexion",
    "Agents utilisateurs",
    "Informations",
  ]);
  await expect(page.getByTestId("integration-overview")).not.toContainText("service_account");
  await page.getByRole("button", { name: "Gérer les connexions", exact: true }).first().click();
  await expect(page.locator("main table")).toHaveCount(1);
  const search = page.getByPlaceholder("Rechercher une connexion…");
  await search.fill("no-matching-account");
  await expect(page.getByText("Aucune connexion ne correspond aux filtres.")).toBeVisible();
  await search.fill("");
  await expect(
    page.getByRole("button", { name: "Ajouter une connexion", exact: true }),
  ).toBeVisible();

  await page.getByTestId("tab-configuration").click();
  const rail = page
    .locator("main nav")
    .filter({ has: page.getByRole("link", { name: "Authentification", exact: true }) });
  await expect(rail.getByRole("link")).toHaveCount(6);
  await expect(page.getByTestId("tab-tools")).toHaveCount(0);
  await expect(rail.getByRole("heading", { name: "Configuration", exact: true })).toBeVisible();
  await expect(rail.getByRole("heading", { name: "Structure", exact: true })).toBeVisible();
  await expect(page.getByTestId("tab-content")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Authentification", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Consulter", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Détails techniques" })).toBeVisible();
  await expect(page.getByText("Identifiant dans le manifeste", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await rail.getByRole("link", { name: "Règles d'accès", exact: true }).click();
  await expect(page.getByTestId("access-rules-section")).toBeVisible();
  await rail.getByRole("link", { name: "Fichiers", exact: true }).click();
  await expect(page).toHaveURL(/integrationSettings=files#configuration$/);
  await expect(page.getByPlaceholder("Rechercher un fichier…")).toBeVisible();
  await expect(rail.getByRole("link", { name: "Fichiers", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.reload();
  await expect(page.getByPlaceholder("Rechercher un fichier…")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("access-rules-section")).toBeVisible();
  await open(`${integration}#about`);
  await expect(page.getByTestId("integration-overview")).toBeVisible();
  await open(`${integration}?keep=deep-link#content`);
  await expect(page).toHaveURL(/keep=deep-link&integrationSettings=files#configuration$/);
  await expect(page.getByTestId("tab-configuration")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByPlaceholder("Rechercher un fichier…")).toBeVisible();
  await expect(page.getByText("manifest.json", { exact: true }).first()).toBeVisible();

  await open("/integrations/@lab/auth-methods#connections");
  await expect(page.locator("main table")).toHaveCount(1);
  await page.getByRole("button", { name: "Ajouter une connexion", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "OAuth (drive)", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "OAuth (mcp)", exact: true })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Identifiants personnalisés", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await open(
    "/integrations/@lab/auth-methods?integrationSettings=auth:service_account#configuration",
  );
  await expect(page.getByTestId("auth-config-service_account")).toBeVisible();
  await expect(page.getByTestId("auth-config-drive")).toBeVisible();
  await open(`${integration}#tools`);
  await expect(page).toHaveURL(/integrationSettings=tools#configuration$/);
  await expect(
    page.getByRole("heading", { name: "Catalogue d’outils", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("integration-tool-drive_search")).toBeVisible();
  await expect(page.getByTestId("tool-inventory-basis")).toContainText("Catalogue du package MCP");
  await expect(page.getByTestId("integration-tool-drive_delete")).toBeVisible();
  await page.getByRole("button", { name: "Voir le détail de drive_delete", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "drive_delete", exact: true })).toContainText(
    "hidden_tools",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Voir le détail de drive_upload", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "drive_upload", exact: true })).toContainText(
    'tools_policy["drive_upload"].required_scopes',
  );
  await page.keyboard.press("Escape");
  await page.getByPlaceholder("Rechercher un outil…").fill("drive_delete");
  await expect(page.getByTestId("integration-tool-drive_search")).toHaveCount(0);
  await expect(page.getByTestId("integration-tool-drive_delete")).toBeVisible();
  await page.getByPlaceholder("Rechercher un outil…").fill("");
  await page.getByRole("link", { name: "Carte", exact: true }).click();
  await expect(page.locator(".react-flow__node-boundary")).toHaveCount(4);
  const groupBounds = await page.locator(".react-flow__node-boundary").evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return [node.dataset.id, { x, y, width, height }];
      }),
    ),
  );
  const sourceBounds = groupBounds["source-boundary"];
  const bundleBounds = groupBounds["bundle-boundary"];
  const configBounds = groupBounds["configuration-boundary"];
  const agentsBounds = groupBounds["agents-boundary"];
  expect(sourceBounds.x + sourceBounds.width).toBeLessThan(bundleBounds.x);
  expect(bundleBounds.x + bundleBounds.width).toBeLessThan(agentsBounds.x);
  expect(configBounds.y + configBounds.height).toBeLessThan(bundleBounds.y);
  expect(Math.abs(sourceBounds.y - bundleBounds.y)).toBeLessThan(1);
  expect(Math.abs(agentsBounds.y - bundleBounds.y)).toBeLessThan(1);
  const accountsNode = page.locator('.react-flow__node[data-id="accounts:drive"]');
  await expect(accountsNode).toContainText("olivier@tractr.net");
  await expect(page.locator('.react-flow__node[data-id="clients:drive"]')).toContainText(
    "sys_a91f2c4d",
  );
  await accountsNode.hover();
  await expect(page.locator('.react-flow__edge[data-id="fine:accounts:drive"]')).toBeVisible();
  // A stationary pointer must not alternate between the card and its new edges.
  const hoverSamples = await page.evaluate(async () => {
    const samples = [];
    for (let index = 0; index < 30; index++) {
      samples.push({
        edge: !!document.querySelector('.react-flow__edge[data-id="fine:accounts:drive"]'),
        viewport: document.querySelector(".react-flow__viewport").getAttribute("style"),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return samples;
  });
  expect(hoverSamples.every((sample) => sample.edge)).toBe(true);
  expect(new Set(hoverSamples.map((sample) => sample.viewport)).size).toBe(1);
  await page.getByRole("heading", { name: "Carte", exact: true }).hover();
  await expect(page.locator('.react-flow__edge[data-id^="fine:"]')).toHaveCount(0);
  await accountsNode.getByRole("button", { name: "olivier@tractr.net OAuth", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Comptes connectés · OAuth", exact: true }).locator("table"),
  ).toBeVisible();
  await expect(page).toHaveURL(/integrationSettings=map#configuration$/);
  await page.keyboard.press("Escape");
  await page
    .locator('.react-flow__node[data-id="clients:drive"]')
    .getByRole("button", { name: "sys_a91f2c4d", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByTestId("oauth-clients-list-drive")).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "À propos de « Catalogue d’outils »", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Catalogue d’outils", exact: true })).toContainText(
    "Chaque agent choisit",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plein écran", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  await expect(page.locator('.react-flow__node[data-id="clients:drive"]')).toBeVisible();
  // Observe the transitions, not just the settled state after hover(). Missing
  // controlled-node measurements briefly hid all nodes before each remeasure.
  await page.evaluate(() => {
    const hidden = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        if (!node.classList?.contains("react-flow__node")) continue;
        if (node.style.visibility === "hidden" || record.oldValue?.includes("visibility: hidden")) {
          hidden.push(node.dataset.id);
        }
      }
    });
    observer.observe(document.querySelector(".react-flow"), {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["style"],
    });
    window.__integrationHoverCheck = { hidden, observer };
  });
  for (const id of [
    "configuration-boundary",
    "clients:drive",
    "accounts:drive",
    "auth:drive",
    "tools",
    "source",
  ]) {
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    // The group center is occupied by its cards; target the exposed group heading.
    await (id.endsWith("-boundary") ? node.getByRole("heading") : node).hover();
  }
  await page.getByRole("heading", { name: "Carte", exact: true }).hover();
  const hiddenDuringHover = await page.evaluate(() => {
    window.__integrationHoverCheck.observer.disconnect();
    return window.__integrationHoverCheck.hidden;
  });
  expect(hiddenDuringHover, "Map nodes must remain visible throughout hover transitions").toEqual(
    [],
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Général", exact: true }).click();
  await expect(page.getByText("Mode du serveur MCP", { exact: true })).toBeVisible();

  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const path of [
      skill,
      "/mcp-servers/@appstrate/gdrive-mcp",
      integration,
      `${integration}#connections`,
      `${integration}#configuration`,
      `${integration}?integrationSettings=files#configuration`,
    ]) {
      await open(path);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      expect(overflow, `${path} overflows at ${width}px`).toBe(false);
      if (path.includes("integrationSettings=files")) {
        const preview = page.getByRole("region", { name: "INTEGRATION.md", exact: true });
        await expect(preview).toBeVisible();
        const bounds = await preview.boundingBox();
        expect(bounds.width, `File preview is squeezed at ${width}px`).toBeGreaterThan(300);
      }
    }
  }

  await context.close();
  const emptyContext = await browser.newContext();
  await emptyContext.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "empty"));
  const emptyPage = await emptyContext.newPage();
  await emptyPage.goto(`${base}${integration}`);
  await expect(emptyPage.getByTestId("integration-overview")).toContainText("Aucune connexion");
  await emptyContext.close();
  expect(failures).toEqual([]);
  console.log(
    `PASS: package substance, history, unified connections, auth navigation, legacy links and ${widths.join("/")}px layouts.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
