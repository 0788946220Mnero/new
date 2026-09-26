import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';

/**
 * Image storage backends. All share: upload(buffer, { folder, ext }) -> { publicId, url },
 * destroy(publicId), url(publicId, width).
 * The folder is always decided by the server (restaurants/<restaurantId>/...).
 */

export function createCloudinaryStorage({ cloudName, apiKey, apiSecret }) {
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  return {
    kind: 'cloudinary',
    configured: true,
    upload(buffer, { folder }) {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: 'image',
            allowed_formats: ['jpg', 'png', 'webp'],
            overwrite: false,
            unique_filename: true,
            use_filename: false,
          },
          (err, res) => (err ? reject(err) : resolve({ publicId: res.public_id, url: res.secure_url })),
        );
        stream.end(buffer);
      });
    },
    async destroy(publicId) {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    },
    url(publicId, width) {
      return cloudinary.url(publicId, {
        secure: true,
        transformation: [{ crop: 'limit', width, fetch_format: 'auto', quality: 'auto' }],
      });
    },
  };
}

/** Development only: files on disk, served by the backend at /media. */
export function createLocalStorage({ dir }) {
  const root = path.resolve(dir);
  return {
    kind: 'local',
    configured: true,
    root,
    async upload(buffer, { folder, ext }) {
      const publicId = `${folder}/${randomBytes(10).toString('hex')}.${ext}`;
      const file = path.join(root, publicId);
      if (!file.startsWith(root + path.sep)) throw new Error('Invalid media path');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buffer, { flag: 'wx' });
      return { publicId, url: `/media/${publicId}` };
    },
    async destroy(publicId) {
      const file = path.join(root, publicId);
      if (!file.startsWith(root + path.sep)) return;
      await unlink(file).catch(() => undefined);
    },
    url(publicId) {
      return `/media/${publicId}`;
    },
  };
}

/** Tests: keeps uploads in a Map. */
export function createMemoryStorage() {
  const files = new Map();
  return {
    kind: 'memory',
    configured: true,
    files,
    async upload(buffer, { folder, ext }) {
      const publicId = `${folder}/${randomBytes(8).toString('hex')}.${ext}`;
      files.set(publicId, buffer.length);
      return { publicId, url: `https://images.test/${publicId}` };
    },
    async destroy(publicId) {
      files.delete(publicId);
    },
    url(publicId, width) {
      return `https://images.test/w_${width}/${publicId}`;
    },
  };
}

export const disabledStorage = { kind: 'disabled', configured: false };

/** Display URLs for an image reference stored in the database. */
export function imageView(image, storage) {
  if (!image?.publicId || !storage?.configured) return null;
  return { url: storage.url(image.publicId, 1200), thumb: storage.url(image.publicId, 400) };
}
