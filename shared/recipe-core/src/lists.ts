export interface ListItem {
  id: string;
  name: string;
  category: string;
  checked: boolean;
}
export interface ShoppingList {
  id: string;
  name: string;
  items: ListItem[];
  version: number;
  updatedAt: string;
}
export const CATEGORIES = ['Produce', 'Dairy', 'Meat & Fish', 'Bakery', 'Pantry', 'Frozen', 'Drinks', 'Household', 'Other'] as const;
