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

  function avatarInitial(user) {
    return String(user?.displayName || user?.username || '?').trim().slice(0, 1).toUpperCase() || '?';
  }

  function renderAvatar(user, className = 'profile-avatar') {
    const avatar = documentObject.createElement('span');
    avatar.className = className;
    if (user?.avatarUrl) {
      const image = documentObject.createElement('img');
      image.src = user.avatarUrl;
      image.alt = '';
      avatar.append(image);
    } else {
      avatar.textContent = avatarInitial(user);
    }
    return avatar;
  }

  async function openProfileDialog() {
    const profilePayload = await fetchJson('/api/auth/profile', { cache: 'no-store' });
    const profileUser = profilePayload.user || state.user;
    const dialog = documentObject.createElement('dialog');
    dialog.className = 'profile-dialog';
    const form = documentObject.createElement('form');
    form.method = 'dialog';
    const heading = documentObject.createElement('h2');
    heading.textContent = 'Your profile';
    const error = documentObject.createElement('p');
    error.className = 'profile-dialog-error';
    error.hidden = true;
    const avatarEditor = documentObject.createElement('div');
    avatarEditor.className = 'profile-avatar-editor';
    const avatar = renderAvatar(profileUser, 'profile-avatar profile-avatar-large');
    const uploadAvatar = documentObject.createElement('button');
    uploadAvatar.type = 'button';
    uploadAvatar.textContent = 'Change avatar';
    const removeAvatar = documentObject.createElement('button');
    removeAvatar.type = 'button';
    removeAvatar.textContent = 'Remove';
    removeAvatar.hidden = !profileUser.avatarUrl;
    const avatarFile = documentObject.createElement('input');
    avatarFile.type = 'file';
    avatarFile.accept = 'image/*';
    avatarFile.hidden = true;
    const avatarControls = documentObject.createElement('div');
    avatarControls.className = 'profile-avatar-controls';
    avatarControls.append(uploadAvatar, removeAvatar, avatarFile);
    avatarEditor.append(avatar, avatarControls);

    const displayName = documentObject.createElement('input');
    displayName.type = 'text';
    displayName.placeholder = 'Display name';
    displayName.maxLength = 80;
    displayName.value = profileUser.displayName || profileUser.username || '';
    const email = documentObject.createElement('input');
    email.type = 'email';
    email.placeholder = 'Email (optional)';
    email.autocomplete = 'email';
    email.value = profilePayload.email || '';
    const currentPassword = documentObject.createElement('input');
    currentPassword.type = 'password';
    currentPassword.placeholder = 'Current password (only to change password)';
    currentPassword.autocomplete = 'current-password';
    const newPassword = documentObject.createElement('input');
    newPassword.type = 'password';
    newPassword.placeholder = 'New password';
    newPassword.autocomplete = 'new-password';
    newPassword.minLength = 6;
    const confirmPassword = documentObject.createElement('input');
    confirmPassword.type = 'password';
    confirmPassword.placeholder = 'Confirm new password';
    confirmPassword.autocomplete = 'new-password';
    confirmPassword.minLength = 6;
    const actions = documentObject.createElement('div');
    actions.className = 'profile-dialog-actions';
    const cancel = documentObject.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const save = documentObject.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save profile';

    function setDialogError(message = '') {
      error.textContent = message;
      error.hidden = !message;
    }
    function applyProfile(payload) {
      state.user = payload.user;
      renderAuth();
      syncUserOnlyUi();
      renderHeaderStats();
      renderFavoritesButton();
    }
    function setAvatarPreview(user) {
      avatar.innerHTML = '';
      if (user?.avatarUrl) {
        const image = documentObject.createElement('img');
        image.src = user.avatarUrl;
        image.alt = '';
        avatar.append(image);
      } else {
        avatar.textContent = avatarInitial(user);
      }
      removeAvatar.hidden = !user?.avatarUrl;
    }

    uploadAvatar.addEventListener('click', () => avatarFile.click());
    avatarFile.addEventListener('change', async () => {
      const file = avatarFile.files?.[0];
      avatarFile.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) return setDialogError('Choose an image file.');
      if (file.size > 20 * 1024 * 1024) return setDialogError('Source image is too large (maximum 20 MB).');
      setDialogError();
      uploadAvatar.disabled = true;
      try {
        const response = await fetch('/api/auth/profile/avatar', { method: 'POST', body: file });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Avatar upload failed.');
        applyProfile(payload);
        setAvatarPreview(payload.user);
      } catch (uploadError) {
        setDialogError(uploadError.message || 'Avatar upload failed.');
      } finally {
        uploadAvatar.disabled = false;
      }
    });
    removeAvatar.addEventListener('click', async () => {
      setDialogError();
      removeAvatar.disabled = true;
      try {
        const payload = await fetchJson('/api/auth/profile/avatar', { method: 'DELETE' });
        applyProfile(payload);
        setAvatarPreview(payload.user);
      } catch (removeError) {
        setDialogError(removeError.message || 'Avatar removal failed.');
      } finally {
        removeAvatar.disabled = false;
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      setDialogError();
      save.disabled = true;
      try {
        const payload = await fetchJson('/api/auth/profile', {
          method: 'POST',
          body: JSON.stringify({
            displayName: displayName.value,
            email: email.value,
            currentPassword: currentPassword.value,
            newPassword: newPassword.value,
            confirmPassword: confirmPassword.value,
          }),
        });
        applyProfile(payload);
        dialog.close();
      } catch (saveError) {
        setDialogError(saveError.message || 'Profile save failed.');
      } finally {
        save.disabled = false;
      }
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    form.append(heading, avatarEditor, displayName, email, currentPassword, newPassword, confirmPassword, error);
    actions.append(cancel, save);
    form.append(actions);
    dialog.append(form);
    documentObject.body.append(dialog);
    dialog.showModal();
    displayName.focus();
  }

  function renderAuth() {
    authElement.innerHTML = '';
    const prefs = preloadPreferences();
    const profile = documentObject.createElement('div');
    profile.className = 'auth-profile';

    const authRow = documentObject.createElement('div');
    authRow.className = 'auth-profile-head';

    if (state.user) {
      const identity = documentObject.createElement('div');
      identity.className = 'auth-identity';
      const name = documentObject.createElement('span');
      name.textContent = state.user.displayName || state.user.username;
      name.className = 'auth-username';
      identity.append(renderAvatar(state.user, 'header-avatar'), name);
      const actions = documentObject.createElement('div');
      actions.className = 'auth-profile-actions';
      const profileButton = documentObject.createElement('button');
      profileButton.type = 'button';
      profileButton.textContent = 'Profile';
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
      profileButton.addEventListener('click', () => openProfileDialog().catch(error => {
        showNotice(error.message || 'Profile load failed.');
      }));
      actions.append(profileButton, logout);
      authRow.append(identity, actions);
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

      async function submit(endpoint, credentials) {
        const submittedUsername = String(credentials.username || '').trim();
        const submittedPassword = String(credentials.password || '');
        const confirmPassword = String(credentials.confirmPassword || '');
        const isRegistration = endpoint.endsWith('/register');
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(submittedUsername)) {
          throw new Error('Username must be 3-40 letters, numbers, dots, dashes, or underscores.');
        }
        if (submittedPassword.length < 6) throw new Error('Password must be at least 6 characters.');
        if (isRegistration && submittedPassword !== confirmPassword) throw new Error('Passwords do not match.');
        const body = {
          username: submittedUsername,
          password: submittedPassword,
        };
        if (isRegistration) {
          body.confirmPassword = confirmPassword;
          body.email = String(credentials.email || '').trim();
        }
        const payload = await fetchJson(endpoint, {
          method: 'POST',
          body: JSON.stringify(body),
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

      function submitWithFeedback() {
        setValidationMessage();
        return submit('/api/auth/login', { username: username.value, password: password.value }).catch(error => {
          setValidationMessage(error.message || 'Unable to sign in.');
          showNotice(error.message);
        });
      }

      function openRegistrationDialog() {
        const dialog = documentObject.createElement('dialog');
        dialog.className = 'registration-dialog';
        const form = documentObject.createElement('form');
        form.method = 'dialog';
        const heading = documentObject.createElement('h2');
        heading.textContent = 'Create account';
        const error = documentObject.createElement('p');
        error.className = 'registration-dialog-error';
        error.hidden = true;

        const dialogUsername = documentObject.createElement('input');
        dialogUsername.type = 'text';
        dialogUsername.placeholder = 'Username';
        dialogUsername.autocomplete = 'username';
        dialogUsername.minLength = 3;
        dialogUsername.maxLength = 40;
        dialogUsername.value = username.value.trim();
        const dialogPassword = documentObject.createElement('input');
        dialogPassword.type = 'password';
        dialogPassword.placeholder = 'Password';
        dialogPassword.autocomplete = 'new-password';
        dialogPassword.minLength = 6;
        const dialogConfirmPassword = documentObject.createElement('input');
        dialogConfirmPassword.type = 'password';
        dialogConfirmPassword.placeholder = 'Confirm password';
        dialogConfirmPassword.autocomplete = 'new-password';
        dialogConfirmPassword.minLength = 6;
        const dialogEmail = documentObject.createElement('input');
        dialogEmail.type = 'email';
        dialogEmail.placeholder = 'Email (optional)';
        dialogEmail.autocomplete = 'email';
        const actions = documentObject.createElement('div');
        actions.className = 'registration-dialog-actions';
        const cancel = documentObject.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        const create = documentObject.createElement('button');
        create.type = 'submit';
        create.textContent = 'Create account';

        function setDialogError(message = '') {
          error.textContent = message;
          error.hidden = !message;
        }

        form.addEventListener('submit', async event => {
          event.preventDefault();
          setDialogError();
          create.disabled = true;
          try {
            await submit('/api/auth/register', {
              username: dialogUsername.value,
              password: dialogPassword.value,
              confirmPassword: dialogConfirmPassword.value,
              email: dialogEmail.value,
            });
            dialog.close();
          } catch (submitError) {
            setDialogError(submitError.message || 'Unable to create account.');
          } finally {
            create.disabled = false;
          }
        });
        cancel.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        form.append(heading, dialogUsername, dialogPassword, dialogConfirmPassword, dialogEmail, error);
        actions.append(cancel, create);
        form.append(actions);
        dialog.append(form);
        documentObject.body.append(dialog);
        dialog.showModal();
        dialogUsername.focus();
      }

      async function openProfileDialog() {
        const profilePayload = await fetchJson('/api/auth/profile', { cache: 'no-store' });
        const profileUser = profilePayload.user || state.user;
        const dialog = documentObject.createElement('dialog');
        dialog.className = 'profile-dialog';
        const form = documentObject.createElement('form');
        form.method = 'dialog';
        const heading = documentObject.createElement('h2');
        heading.textContent = 'Your profile';
        const error = documentObject.createElement('p');
        error.className = 'profile-dialog-error';
        error.hidden = true;

        const avatarEditor = documentObject.createElement('div');
        avatarEditor.className = 'profile-avatar-editor';
        const avatar = renderAvatar(profileUser, 'profile-avatar profile-avatar-large');
        const avatarControls = documentObject.createElement('div');
        avatarControls.className = 'profile-avatar-controls';
        const uploadAvatar = documentObject.createElement('button');
        uploadAvatar.type = 'button';
        uploadAvatar.textContent = 'Change avatar';
        const removeAvatar = documentObject.createElement('button');
        removeAvatar.type = 'button';
        removeAvatar.textContent = 'Remove';
        removeAvatar.hidden = !profileUser.avatarUrl;
        const avatarFile = documentObject.createElement('input');
        avatarFile.type = 'file';
        avatarFile.accept = 'image/*';
        avatarFile.hidden = true;
        avatarControls.append(uploadAvatar, removeAvatar, avatarFile);
        avatarEditor.append(avatar, avatarControls);

        const displayName = documentObject.createElement('input');
        displayName.type = 'text';
        displayName.placeholder = 'Display name';
        displayName.maxLength = 80;
        displayName.value = profileUser.displayName || profileUser.username || '';
        const email = documentObject.createElement('input');
        email.type = 'email';
        email.placeholder = 'Email (optional)';
        email.autocomplete = 'email';
        email.value = profilePayload.email || '';
        const currentPassword = documentObject.createElement('input');
        currentPassword.type = 'password';
        currentPassword.placeholder = 'Current password (only to change password)';
        currentPassword.autocomplete = 'current-password';
        const newPassword = documentObject.createElement('input');
        newPassword.type = 'password';
        newPassword.placeholder = 'New password';
        newPassword.autocomplete = 'new-password';
        newPassword.minLength = 6;
        const confirmPassword = documentObject.createElement('input');
        confirmPassword.type = 'password';
        confirmPassword.placeholder = 'Confirm new password';
        confirmPassword.autocomplete = 'new-password';
        confirmPassword.minLength = 6;
        const actions = documentObject.createElement('div');
        actions.className = 'profile-dialog-actions';
        const cancel = documentObject.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        const save = documentObject.createElement('button');
        save.type = 'submit';
        save.textContent = 'Save profile';

        function setDialogError(message = '') {
          error.textContent = message;
          error.hidden = !message;
        }

        function applyProfile(payload) {
          state.user = payload.user;
          renderAuth();
          syncUserOnlyUi();
          renderHeaderStats();
          renderFavoritesButton();
        }

        function setAvatarPreview(user) {
          avatar.innerHTML = '';
          if (user?.avatarUrl) {
            const image = documentObject.createElement('img');
            image.src = user.avatarUrl;
            image.alt = '';
            avatar.append(image);
          } else {
            avatar.textContent = avatarInitial(user);
          }
          removeAvatar.hidden = !user?.avatarUrl;
        }

        async function browserAvatarBlob(file) {
          if (!file?.type?.startsWith('image/')) throw new Error('Choose an image file.');
          if (file.size > 20 * 1024 * 1024) throw new Error('Source image is too large (maximum 20 MB).');
          return new Promise((resolve, reject) => {
            const image = new Image();
            const objectUrl = URL.createObjectURL(file);
            image.onload = () => {
              URL.revokeObjectURL(objectUrl);
              const size = Math.min(image.naturalWidth, image.naturalHeight);
              const sourceX = (image.naturalWidth - size) / 2;
              const sourceY = (image.naturalHeight - size) / 2;
              const canvas = documentObject.createElement('canvas');
              canvas.width = 512;
              canvas.height = 512;
              canvas.getContext('2d').drawImage(image, sourceX, sourceY, size, size, 0, 0, 512, 512);
              const encode = quality => canvas.toBlob(blob => {
                if (!blob) return reject(new Error('Could not process that image.'));
                if (blob.size <= 256 * 1024) return resolve(blob);
                if (quality <= 0.2) return reject(new Error('Could not compress avatar below 256 KB.'));
                encode(quality - 0.1);
              }, 'image/jpeg', quality);
              encode(0.9);
            };
            image.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              reject(new Error('Could not read that image.'));
            };
            image.src = objectUrl;
          });
        }

        uploadAvatar.addEventListener('click', () => avatarFile.click());
        avatarFile.addEventListener('change', async () => {
          const file = avatarFile.files?.[0];
          avatarFile.value = '';
          if (!file) return;
          setDialogError();
          uploadAvatar.disabled = true;
          try {
            const image = await browserAvatarBlob(file);
            const response = await fetch('/api/auth/profile/avatar', {
              method: 'POST',
              headers: { 'content-type': 'image/jpeg' },
              body: image,
            });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Avatar upload failed.');
            applyProfile(payload);
            setAvatarPreview(payload.user);
          } catch (uploadError) {
            setDialogError(uploadError.message || 'Avatar upload failed.');
          } finally {
            uploadAvatar.disabled = false;
          }
        });
        removeAvatar.addEventListener('click', async () => {
          setDialogError();
          removeAvatar.disabled = true;
          try {
            const payload = await fetchJson('/api/auth/profile/avatar', { method: 'DELETE' });
            applyProfile(payload);
            setAvatarPreview(payload.user);
          } catch (removeError) {
            setDialogError(removeError.message || 'Avatar removal failed.');
          } finally {
            removeAvatar.disabled = false;
          }
        });
        form.addEventListener('submit', async event => {
          event.preventDefault();
          setDialogError();
          save.disabled = true;
          try {
            const payload = await fetchJson('/api/auth/profile', {
              method: 'POST',
              body: JSON.stringify({
                displayName: displayName.value,
                email: email.value,
                currentPassword: currentPassword.value,
                newPassword: newPassword.value,
                confirmPassword: confirmPassword.value,
              }),
            });
            applyProfile(payload);
            dialog.close();
          } catch (saveError) {
            setDialogError(saveError.message || 'Profile save failed.');
          } finally {
            save.disabled = false;
          }
        });
        cancel.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        form.append(heading, avatarEditor, displayName, email, currentPassword, newPassword, confirmPassword, error);
        actions.append(cancel, save);
        form.append(actions);
        dialog.append(form);
        documentObject.body.append(dialog);
        dialog.showModal();
        displayName.focus();
      }

      username.addEventListener('input', () => setValidationMessage());
      password.addEventListener('input', () => setValidationMessage());
      login.addEventListener('click', submitWithFeedback);
      register.addEventListener('click', openRegistrationDialog);
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
