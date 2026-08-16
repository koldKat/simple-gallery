let tooltip = null;
let tooltipTarget = null;

const mobileMedia = window.matchMedia('(max-width: 820px), (hover: none), (pointer: coarse)');

function ensureTooltip() {
  if (tooltip) return tooltip;
  tooltip = document.createElement('div');
  tooltip.className = 'app-tooltip';
  tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

export function setTooltip(element, text) {
  if (!element) return;
  const label = String(text || '').trim();
  delete element.dataset.tooltipAuto;
  element.removeAttribute('title');
  if (!label) {
    element.removeAttribute('data-tooltip');
    element.removeAttribute('aria-label');
    return;
  }
  element.dataset.tooltip = label;
  element.setAttribute('aria-label', label);
}

function defaultButtonTooltip(button) {
  if (!(button instanceof HTMLButtonElement)) return '';
  if (button.matches('.model-card, .browser-model-card, .gallery-card, .favorite-image-card, .image-tile')) return '';
  const buttonText = String(button.textContent || '').replace(/\s+/g, ' ').trim();
  if (button.closest('.letter-bar')) {
    return buttonText === 'All' ? 'Show all models' : `Show models starting with ${buttonText}`;
  }
  if (button.closest('.selected-gallery-actions')) {
    const labels = {
      Previous: 'Open previous gallery',
      Next: 'Open next gallery',
      'All galleries': 'Show all galleries for this model',
      'Hide galleries': 'Hide the gallery list',
      'Mark seen': 'Mark every image in this gallery seen',
      'Mark unseen': 'Mark every image in this gallery unseen',
    };
    return labels[buttonText] || '';
  }
  if (button.closest('.pager-row')) {
    if (buttonText === 'Previous') return 'Open previous models page';
    if (buttonText === 'Next') return 'Open next models page';
  }
  if (button.closest('.favorite-image-actions')) {
    if (buttonText === 'Gallery') return "Open this image's gallery";
    if (buttonText === 'Model') return "Open this image's model";
  }
  if (buttonText === 'Random' && button.closest('.favorites-section-head')) {
    return 'Shuffle favorite images and open the first';
  }
  return '';
}

function ensureDefaultButtonTooltip(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  if (button.dataset.tooltip && !button.dataset.tooltipAuto) return;
  const label = defaultButtonTooltip(button);
  if (!label) {
    if (button.dataset.tooltipAuto) {
      delete button.dataset.tooltip;
      delete button.dataset.tooltipAuto;
      button.removeAttribute('aria-label');
    }
    return;
  }
  button.dataset.tooltip = label;
  button.dataset.tooltipAuto = '1';
  button.setAttribute('aria-label', label);
}

function syncDefaultButtonTooltips(root = document) {
  if (root instanceof HTMLButtonElement) ensureDefaultButtonTooltip(root);
  root.querySelectorAll?.('button').forEach(ensureDefaultButtonTooltip);
}

function positionTooltip(anchor, pointerEvent = null) {
  if (!tooltip || !anchor) return;
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  let left = pointerEvent ? pointerEvent.clientX + margin : rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  let top = pointerEvent ? pointerEvent.clientY + margin : rect.top - tooltipRect.height - margin;
  if (left + tooltipRect.width > window.innerWidth - margin) left = window.innerWidth - tooltipRect.width - margin;
  if (top + tooltipRect.height > window.innerHeight - margin) top = window.innerHeight - tooltipRect.height - margin;
  if (top < margin) top = rect.bottom + margin;
  if (left < margin) left = margin;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hideTooltip(target = null) {
  if (target && tooltipTarget !== target) return;
  if (!tooltip) return;
  tooltipTarget = null;
  tooltip.classList.remove('is-visible');
  tooltip.hidden = true;
}

function showTooltip(target, pointerEvent = null) {
  if (mobileMedia.matches) {
    hideTooltip();
    return;
  }
  const text = target?.dataset?.tooltip || '';
  if (!text) return;
  const element = ensureTooltip();
  tooltipTarget = target;
  element.textContent = text;
  element.hidden = false;
  element.classList.add('is-visible');
  positionTooltip(target, pointerEvent);
}

export function initAppTooltips() {
  document.querySelectorAll('[title]').forEach(element => setTooltip(element, element.getAttribute('title')));
  syncDefaultButtonTooltips();
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const parentButton = mutation.target instanceof Element
        ? mutation.target.closest('button')
        : mutation.target.parentElement?.closest('button');
      if (parentButton?.dataset.tooltipAuto) ensureDefaultButtonTooltip(parentButton);
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) syncDefaultButtonTooltips(node);
      }
    }
    if (tooltipTarget && !tooltipTarget.isConnected) hideTooltip();
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  document.addEventListener('mouseover', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (!target || target.contains(event.relatedTarget)) return;
    showTooltip(target, event);
  });
  document.addEventListener('mousemove', event => {
    if (tooltipTarget) positionTooltip(tooltipTarget, event);
  });
  document.addEventListener('mouseout', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (!target || target.contains(event.relatedTarget)) return;
    hideTooltip(target);
  });
  document.addEventListener('focusin', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (target) showTooltip(target);
  });
  document.addEventListener('focusout', event => {
    const target = event.target?.closest?.('[data-tooltip]');
    if (target) hideTooltip(target);
  });
  window.addEventListener('scroll', () => hideTooltip(), { passive: true });
  mobileMedia.addEventListener('change', event => {
    if (event.matches) hideTooltip();
  });
  document.addEventListener('touchstart', () => hideTooltip(), { passive: true });
}
