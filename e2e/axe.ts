import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
/** WCAG 2.2 AA rule set (C-55). */
export const axe = (page: Page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
