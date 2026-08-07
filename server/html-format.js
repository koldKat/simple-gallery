'use strict';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function formatDateLabel(value) {
  if (!value) return 'date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date unknown';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function renderStatsBreakdown(values = {}) {
  return `
    <span class="stat-part stat-models"><span class="stat-num">${formatCount(values.models)}</span><span class="stat-word">models</span></span>
    <span class="stat-part stat-galleries"><span class="stat-num">${formatCount(values.galleries)}</span><span class="stat-word">galleries</span></span>
    <span class="stat-part stat-images"><span class="stat-num">${formatCount(values.images)}</span><span class="stat-word">images</span></span>
  `;
}

function seoKeywords(...groups) {
  const seen = new Set();
  const ordered = [];
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group];
    for (const value of values) {
      const keyword = String(value || '').trim();
      if (!keyword) continue;
      const key = keyword.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(keyword);
    }
  }
  return ordered.join(', ');
}

module.exports = {
  escapeHtml,
  escapeJsonForHtml,
  formatDateLabel,
  formatCount,
  renderStatsBreakdown,
  seoKeywords,
};
