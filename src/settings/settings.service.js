import { imageView } from '../media/imageStorage.js';
import { tenantAudit } from '../restaurantAuth/tenantAudit.js';

export const FONTS = Object.freeze(['Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Almarai', 'Noto Kufi Arabic']);

export function settingsView(s, storage) {
  const info = s?.info ?? {};
  const theme = s?.theme ?? {};
  return {
    info: {
      name: info.name ?? '',
      phone: info.phone ?? '',
      whatsapp: info.whatsapp ?? '',
      address: info.address ?? '',
      social: {
        instagram: info.social?.instagram ?? '',
        facebook: info.social?.facebook ?? '',
        tiktok: info.social?.tiktok ?? '',
      },
    },
    logo: imageView(s?.logo, storage),
    banner: imageView(s?.banner, storage),
    theme: {
      primaryColor: theme.primaryColor ?? '#1F2937',
      secondaryColor: theme.secondaryColor ?? '#F59E0B',
      font: FONTS.includes(theme.font) ? theme.font : 'Cairo',
      layout: theme.layout === 'list' ? 'list' : 'grid',
    },
    language: s?.language ?? 'ar',
    hideUnavailableProducts: Boolean(s?.hideUnavailableProducts),
  };
}

export class SettingsService {
  #storage;
  #logger;
  #onChange;

  constructor({ storage, logger, onChange }) {
    this.#storage = storage;
    this.#logger = logger;
    this.#onChange = onChange;
  }

  async get(tenant) {
    return settingsView(await tenant.models.Settings.findById('main').lean(), this.#storage);
  }

  /** patch is validated by the route; nested objects are merged field by field. */
  async update(tenant, patch, { actor, ip } = {}) {
    const $set = {};
    const flatten = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, `${prefix}${k}.`);
        else $set[`${prefix}${k}`] = v;
      }
    };
    flatten(patch, '');
    if (Object.keys($set).length) {
      await tenant.models.Settings.updateOne({ _id: 'main' }, { $set }, { upsert: true, runValidators: true });
      await tenantAudit(tenant, { userId: actor?.id, action: 'settings.updated', resource: 'settings', resourceId: 'main', ip, metadata: { fields: Object.keys($set) } }, this.#logger);
      this.#onChange?.(tenant.restaurantId);
    }
    return this.get(tenant);
  }
}
