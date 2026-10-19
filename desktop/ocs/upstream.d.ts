import type { Page } from 'playwright-core';
export function automationCatalog(): { name: string; fields: { key: string; label: string; secret: boolean; initialValue: string }[] }[];
export function runNavigation(page: Page, name: string, values: { key: string; value: string }[]): Promise<void>;
