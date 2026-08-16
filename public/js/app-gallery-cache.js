export function createGalleryPayloadCache({ requestUrl, mergePayload, fetchImpl = window.fetch.bind(window) }) {
  let payloads = new Map();
  let inflight = new Map();

  function galleryKey(gallery) {
    return [
      gallery?.id || '',
      gallery?.dbId || '',
      gallery?.count || 0,
      gallery?.updatedAtMs || gallery?.updatedAt || '',
      gallery?.cover || '',
    ].join('\n');
  }

  function clear() {
    payloads = new Map();
    inflight = new Map();
  }

  async function fetchPayload(gallery) {
    if (!gallery?.id) throw new Error('Invalid gallery.');
    const key = galleryKey(gallery);
    if (payloads.has(key)) return payloads.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      const response = await fetchImpl(requestUrl(gallery), { cache: 'no-store' });
      if (!response.ok) {
        let message = 'Failed to load gallery images.';
        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch {
          // Keep generic message when the response is not JSON.
        }
        throw new Error(message);
      }
      const payload = mergePayload(gallery, await response.json());
      payloads.set(key, payload);
      return payload;
    })();
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  function patchSeen(galleryDbId, seenCount, seen, options = {}) {
    for (const [key, payload] of payloads.entries()) {
      if (Number(payload?.dbId || 0) !== Number(galleryDbId || 0)) continue;
      const images = Array.isArray(payload.images) ? payload.images.map(image => {
        if (seen || options.allImages === true) return { ...image, seen: Boolean(seen) };
        if (options.imageName && image.name === options.imageName) {
          return { ...image, seen: Boolean(options.imageSeen) };
        }
        return image;
      }) : [];
      payloads.set(key, {
        ...payload,
        seen: Boolean(seen),
        seenCount: Number(seenCount || 0),
        images,
      });
    }
  }

  function patchFavorite(galleryDbId, imageName, favorite) {
    const dbId = Number(galleryDbId || 0);
    const name = String(imageName || '');
    if (!dbId || !name) return;
    for (const [key, payload] of payloads.entries()) {
      if (Number(payload?.dbId || 0) !== dbId || !Array.isArray(payload.images)) continue;
      payloads.set(key, {
        ...payload,
        images: payload.images.map(image => (
          image.name === name ? { ...image, favorite: Boolean(favorite) } : image
        )),
      });
    }
  }

  return { clear, fetch: fetchPayload, patchFavorite, patchSeen };
}
