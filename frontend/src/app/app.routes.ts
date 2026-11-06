import type { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth-guard';
import { unsavedChangesGuard } from './core/guards/unsaved-changes-guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'recipes' },
  { path: 'signin', loadComponent: () => import('./features/signin/signin').then((m) => m.Signin) },
  { path: 'callback', loadComponent: () => import('./features/callback/oauth-callback').then((m) => m.OAuthCallback) },
  {
    path: 'recipes',
    canActivate: [authGuard],
    loadComponent: () => import('./features/recipes/recipes').then((m) => m.Recipes),
  },
  {
    path: 'recipes/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./features/recipes/recipe-detail').then((m) => m.RecipeDetail),
  },
  {
    path: 'recipes/:id/edit',
    canActivate: [authGuard],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./features/recipes/recipe-edit').then((m) => m.RecipeEdit),
  },
  {
    path: 'lists',
    canActivate: [authGuard],
    loadComponent: () => import('./features/lists/lists').then((m) => m.Lists),
  },
  {
    // Web Share Target lands here as GET /import?title=&text=&url=
    path: 'import',
    canActivate: [authGuard],
    loadComponent: () => import('./features/import/import').then((m) => m.Import),
  },
  { path: '**', redirectTo: 'recipes' },
];
