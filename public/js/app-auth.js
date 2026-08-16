export function createAuthController(options) {
  const {
    state,
    authElement,
    preloadPreferences,
    fetchJson,
    syncUserOnlyUi,
    renderHeaderStats,
    renderFavoritesButton,
    loadCurrentUserStats,
    loadState,
    saveUserSettings,
    saveAnonymousPreloadSettings,
    showNotice,
    documentObject = document,
  } = options;

  function renderAuth() {
    authElement.innerHTML = '';
    const prefs = preloadPreferences();
    const profile = documentObject.createElement('div');
    profile.className = 'auth-profile';

    const authRow = documentObject.createElement('div');
    authRow.className = 'auth-profile-head';

    if (state.user) {
      const name = documentObject.createElement('span');
      name.textContent = state.user.displayName || state.user.username;
      name.className = 'auth-username';
      const logout = documentObject.createElement('button');
      logout.type = 'button';
      logout.textContent = 'Logout';
      logout.addEventListener('click', async () => {
        await fetchJson('/api/auth/logout', { method: 'POST' });
        state.user = null;
        state.favorites = null;
        syncUserOnlyUi();
        renderHeaderStats();
        if (state.mode === 'favorites') state.mode = 'home';
        await loadState();
      });
      authRow.append(name, logout);
    } else {
      const fieldsRow = documentObject.createElement('div');
      fieldsRow.className = 'auth-credential-row';
      const buttonsRow = documentObject.createElement('div');
      buttonsRow.className = 'auth-button-row';

      const username = documentObject.createElement('input');
      username.type = 'text';
      username.placeholder = 'Username';
      username.autocomplete = 'username';
      const password = documentObject.createElement('input');
      password.type = 'password';
      password.placeholder = 'Password';
      password.autocomplete = 'current-password';
      const login = documentObject.createElement('button');
      login.type = 'button';
      login.textContent = 'Login';
      const register = documentObject.createElement('button');
      register.type = 'button';
      register.textContent = 'Register';

      async function submit(endpoint) {
        const payload = await fetchJson(endpoint, {
          method: 'POST',
          body: JSON.stringify({ username: username.value.trim(), password: password.value }),
        });
        state.user = payload.user;
        state.userStats = null;
        renderAuth();
        syncUserOnlyUi();
        renderFavoritesButton();
        await loadCurrentUserStats();
        await loadState();
      }

      login.addEventListener('click', () => submit('/api/auth/login').catch(error => showNotice(error.message)));
      register.addEventListener('click', () => submit('/api/auth/register').catch(error => showNotice(error.message)));
      fieldsRow.append(username, password);
      buttonsRow.append(login, register);
      authRow.append(fieldsRow, buttonsRow);
    }

    const settings = documentObject.createElement('div');
    settings.className = 'auth-profile-settings';

    const preloadModel = documentObject.createElement('label');
    preloadModel.className = 'auth-setting';
    const preloadModelInput = documentObject.createElement('input');
    preloadModelInput.type = 'checkbox';
    preloadModelInput.checked = Boolean(prefs.preloadModel);
    preloadModelInput.addEventListener('change', () => {
      const next = {
        preloadModel: preloadModelInput.checked,
        preloadGallery: preloadGalleryInput.checked,
      };
      if (state.user) {
        saveUserSettings(next).catch(error => {
          const current = preloadPreferences();
          preloadModelInput.checked = Boolean(current.preloadModel);
          preloadGalleryInput.checked = Boolean(current.preloadGallery);
          showNotice(error.message);
        });
      } else {
        saveAnonymousPreloadSettings(next);
      }
    });
    preloadModel.append(preloadModelInput, documentObject.createTextNode(' Preload model'));

    const preloadGallery = documentObject.createElement('label');
    preloadGallery.className = 'auth-setting';
    const preloadGalleryInput = documentObject.createElement('input');
    preloadGalleryInput.type = 'checkbox';
    preloadGalleryInput.checked = Boolean(prefs.preloadGallery);
    preloadGalleryInput.addEventListener('change', () => {
      const next = {
        preloadModel: preloadModelInput.checked,
        preloadGallery: preloadGalleryInput.checked,
      };
      if (state.user) {
        saveUserSettings(next).catch(error => {
          const current = preloadPreferences();
          preloadModelInput.checked = Boolean(current.preloadModel);
          preloadGalleryInput.checked = Boolean(current.preloadGallery);
          showNotice(error.message);
        });
      } else {
        saveAnonymousPreloadSettings(next);
      }
    });
    preloadGallery.append(preloadGalleryInput, documentObject.createTextNode(' Preload gallery'));

    settings.append(preloadModel, preloadGallery);
    profile.append(settings, authRow);
    authElement.append(profile);
  }

  return { render: renderAuth };
}
