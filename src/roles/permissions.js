export const PERMISSIONS = Object.freeze([
  'menu.view',
  'categories.create',
  'categories.update',
  'categories.delete',
  'categories.reorder',
  'products.create',
  'products.update',
  'products.delete',
  'products.reorder',
  'products.toggleAvailability',
  'images.upload',
  'settings.view',
  'settings.update',
  'users.manage',
]);

/**
 * Owner permissions are derived from the role at runtime (not stored), so new
 * permissions added later apply to every existing owner automatically.
 * Editors get this default set; the Owner can adjust it per user (Phase 4).
 */
export const ROLE_PERMISSIONS = Object.freeze({
  Owner: PERMISSIONS,
  Editor: Object.freeze(PERMISSIONS.filter((p) => !['users.manage', 'settings.update'].includes(p))),
});

export function effectivePermissions(user) {
  if (user.role === 'Owner') return ROLE_PERMISSIONS.Owner;
  return user.permissions?.length ? user.permissions : ROLE_PERMISSIONS[user.role] ?? [];
}
