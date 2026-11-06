export interface SeedOptions {
  apiUrl?: string;
  sub?: string;
  reset?: boolean;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
}
export interface SeedSummary {
  apiUrl: string;
  sub: string;
  recipesCreated: number;
  recipesSkipped: number;
  recipesDeleted: number;
  listCreated: boolean;
  listsDeleted: number;
  items: number;
  checked: number;
}
export const RECIPES: Record<string, unknown>[];
export const LIST_NAME: string;
export const LIST_ITEMS: { name: string; category: string }[];
export const CHECKED: string[];
export function seed(opts?: SeedOptions): Promise<SeedSummary>;
