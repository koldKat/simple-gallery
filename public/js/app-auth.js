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
    clearUserLibraryState,
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
        state.userStats = null;
        state.favorites = null;
        clearUserLibraryState();
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
      const validationMessage = documentObject.createElement('div');
      validationMessage.className = 'auth-validation-message';
      validationMessage.setAttribute('role', 'alert');
      validationMessage.hidden = true;

      function setValidationMessage(message = '') {
        validationMessage.textContent = message;
        validationMessage.hidden = !message;
      }

      const username = documentObject.createElement('input');
      username.type = 'text';
      username.placeholder = 'Username';
      username.autocomplete = 'username';
      username.minLength = 3;
      username.maxLength = 40;
      username.pattern = '[A-Za-z0-9_.-]{3,40}';
      username.title = '3-40 letters, numbers, dots, dashes, or underscores';
      const password = documentObject.createElement('input');
      password.type = 'password';
      password.placeholder = 'Password';
      password.autocomplete = 'current-password';
      password.minLength = 6;
      password.title = 'At least 6 characters';
      const login = documentObject.createElement('button');
      login.type = 'button';
      login.textContent = 'Login';
      const register = documentObject.createElement('button');
      register.type = 'button';
      register.textContent = 'Register';

      async function submit(endpoint) {
        setValidationMessage();
        const submittedUsername = username.value.trim();
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(submittedUsername)) {
          throw new Error('Username must be 3-40 letters, numbers, dots, dashes, or underscores.');
        }
        if (password.value.length < 6) throw new Error('Password must be at least 6 characters.');
        const payload = await fetchJson(endpoint, {
          method: 'POST',
          body: JSON.stringify({ username: submittedUsername, password: password.value }),
        });
        state.user = payload.user;
        state.userStats = null;
        clearUserLibraryState();
        renderAuth();
        syncUserOnlyUi();
        renderHeaderStats();
        renderFavoritesButton();
        await loadCurrentUserStats();
        await loadState();
      }

      function submitWithFeedback(endpoint) {
        submit(endpoint).catch(error => {
          setValidationMessage(error.message || 'Unable to sign in.');
          showNotice(error.message);
        });
      }

      username.addEventListener('input', () => setValidationMessage());
      password.addEventListener('input', () => setValidationMessage());
      login.addEventListener('click', () => submitWithFeedback('/api/auth/login'));
      register.addEventListener('click', () => submitWithFeedback('/api/auth/register'));
      fieldsRow.append(username, password);
      buttonsRow.append(login, register);
      authRow.append(fieldsRow, buttonsRow, validationMessage);
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
