'use strict';

function handleViewsRoute(ctx, req, res, url) {
  const {
    readRequestBody,
    sendJson,
    recordView,
  } = ctx;

  if (url.pathname === '/api/views' && req.method === 'POST') {
    readRequestBody(req)
      .then(body => {
        const result = recordView(req, JSON.parse(body || '{}'));
        const headers = result.setCookie ? { 'set-cookie': result.setCookie } : {};
        sendJson(res, 200, { ok: true, counted: result.counted }, headers);
      })
      .catch(error => sendJson(res, 400, { error: error.message || 'Record view failed.' }));
    return true;
  }

  return false;
}

module.exports = {
  handleViewsRoute,
};
