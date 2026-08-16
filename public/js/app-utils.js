export function titleCase(value) {
  return String(value || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

export function searchText(value) {
  return String(value || '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function formatDate(value, locales = undefined) {
  if (!value) return 'date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date unknown';
  return date.toLocaleDateString(locales, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function modelPath(modelId) {
  return `/model/${encodeURIComponent(modelId)}`;
}

export function galleryPath(modelId, galleryName) {
  return `${modelPath(modelId)}/gallery/${encodeURIComponent(galleryName)}`;
}

export function pathForState(state) {
  if (state.mode === 'models') return '/models';
  if (state.mode === 'favorites') return '/favorites';
  if (state.mode === 'model' && state.selectedModel && state.selectedGallery) {
    const galleryName = String(state.selectedGallery).split('/')[1] || '';
    return galleryPath(state.selectedModel, galleryName);
  }
  if (state.mode === 'model' && state.selectedModel) return modelPath(state.selectedModel);
  return '/';
}

function safeDecodePathPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseAppPath(pathname) {
  const parts = String(pathname || '/').split('/').filter(Boolean).map(safeDecodePathPart);
  if (!parts.length) return { recognized: true, mode: 'home' };
  if (parts[0] === 'models') return { recognized: true, mode: 'models' };
  if (parts[0] === 'favorites') return { recognized: true, mode: 'favorites' };
  if (parts[0] === 'model' && parts[1] && parts[2] === 'gallery' && parts[3]) {
    return { recognized: true, mode: 'model', modelId: parts[1], galleryName: parts[3] };
  }
  if (parts[0] === 'model' && parts[1]) {
    return { recognized: true, mode: 'model', modelId: parts[1], galleryName: null };
  }
  return { recognized: false, mode: 'home' };
}

export function shuffledModels(models, seed) {
  const list = models.slice();
  let stateSeed = (seed >>> 0) || 1;
  function nextRandom() {
    stateSeed = (stateSeed * 1664525 + 1013904223) >>> 0;
    return stateSeed / 4294967296;
  }
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list;
}
