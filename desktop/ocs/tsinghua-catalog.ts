import { z } from 'zod';

export interface TsinghuaCatalogNode {
  key: string | null;
  pageId: string | null;
  children: TsinghuaCatalogNode[];
}
const identifier = z.string().min(1).max(200).refine(value => value.trim() === value);
const directoryNodeSchema: z.ZodType<TsinghuaCatalogNode> = z.lazy(() => z.object({
  // Grouping nodes may have no pageId; the course container is not a directory node.
  key: identifier.nullish().transform(value => value ?? null),
  pageId: identifier.or(z.literal('')).nullish().transform(value => value === '' || value == null ? null : value),
  // Public getParents/getCatalogOrder treat absent children as a leaf.
  children: z.array(directoryNodeSchema).max(10000).nullish().transform(value => value ?? [])
}));
const listSchema = z.object({ status: z.literal(true), object: z.object({ children: z.array(directoryNodeSchema).max(10000) }) });
const unitSchema = z.object({ status: z.literal(true), object: directoryNodeSchema });

function project<T>(schema: z.ZodType<T>, value: object): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError('TSH_CATALOG_SHAPE: Official catalog response requires status=true and valid object.children/key/pageId structure.');
  return parsed.data;
}

/** Project only object.children; the natural list container's key is not a page key. */
export function parseTsinghuaCatalogList(value: object): TsinghuaCatalogNode[] {
  return project(listSchema, value).object.children;
}

export function parseTsinghuaCatalogUnit(value: object): TsinghuaCatalogNode {
  const unit = project(unitSchema, value).object;
  if (!identifier.safeParse(unit.key).success) throw new TypeError('TSH_CATALOG_UNIT_KEY: The natural directory unit requires its own nonempty key.');
  return unit;
}

/** Preserve the reviewed diagnostic traversal and public getCatalogOrder semantics. */
function matchingNodes(roots: readonly TsinghuaCatalogNode[], key: string): TsinghuaCatalogNode[] {
  return roots.flatMap(node => [ ...(node.key === key ? [node] : []), ...matchingNodes(node.children, key) ]);
}

/** Replace a naturally loaded unit subtree instead of double-counting list and unit responses. */
export function mergeTsinghuaCatalogUnit(roots: readonly TsinghuaCatalogNode[], unit: TsinghuaCatalogNode): TsinghuaCatalogNode[] {
  if (unit.key === null || !identifier.safeParse(unit.key).success) throw new TypeError('TSH_CATALOG_UNIT_KEY: The natural directory unit requires its own nonempty key.');
  const matches = matchingNodes(roots, unit.key);
  if (matches.length > 1) throw new RangeError('TSH_CATALOG_AMBIGUOUS: The directory unit key matches multiple catalog nodes.');
  if (matches.length === 0) return [...roots, unit];
  function replace(nodes: readonly TsinghuaCatalogNode[]): TsinghuaCatalogNode[] {
    return nodes.map(node => node.key === unit.key ? unit : { ...node, children: replace(node.children) });
  }
  return replace(roots);
}

/** Route node.key and request node.pageId are distinct official identities. */
export function resolveTsinghuaCatalogPage(roots: readonly TsinghuaCatalogNode[], routeKey: string): string {
  if (!identifier.safeParse(routeKey).success) throw new TypeError('TSH_CATALOG_ROUTE_KEY: A nonempty route key is required.');
  const matches = matchingNodes(roots, routeKey);
  if (matches.length === 0) throw new DOMException('TSH_CATALOG_MISSING: No natural directory node matches the current route key.', 'InvalidStateError');
  if (matches.length !== 1) throw new RangeError('TSH_CATALOG_AMBIGUOUS: The route key matches multiple catalog nodes.');
  const node = matches[0];
  if (!node || node.pageId === null || !identifier.safeParse(node.pageId).success) throw new TypeError('TSH_CATALOG_PAGE_ID: The unique directory node has no nonempty pageId; grouping nodes cannot bind exercise responses.');
  return node.pageId;
}