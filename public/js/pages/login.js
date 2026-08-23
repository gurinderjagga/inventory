/** Login page */

import { api } from '../api.js';

export function renderLogin(onSuccess) {
  const el = document.getElementById('auth-app');
  el.innerHTML = `
    <div class="login-card">
      <div class="login-brand">
        <div class="login-brand-icon">📦</div>
        <h1>StockFlow</h1>
        <p>Inventory Management & Invoicing</p>
      </div>

      <div id="login-error" class="login-error hidden">
        <i class="bi bi-exclamation-circle"></i>
        <span id="login-error-msg">Invalid credentials</span>
      </div>

      <form class="login-form" id="login-form" novalidate>
        <div class="form-group">
          <label for="login-username">Username</label>
          <div class="input-icon-wrap">
            <i class="bi bi-person"></i>
            <input
              id="login-username"
              type="text"
              placeholder="Enter your username"
              autocomplete="username"
              required
            />
          </div>
        </div>

        <div class="form-group">
          <label for="login-password">Password</label>
          <div class="input-icon-wrap">
            <i class="bi bi-lock"></i>
            <input
              id="login-password"
              type="password"
              placeholder="Enter your password"
              autocomplete="current-password"
              required
            />
          </div>
        </div>

        <button type="submit" class="btn btn-primary w-full" id="login-btn" style="justify-content:center;padding:11px;">
          <span id="login-btn-text">Sign In</span>
          <span id="login-spinner" class="hidden"><span class="spinner" style="width:16px;height:16px;border-width:2px"></span></span>
        </button>
      </form>

      <div class="login-footer">
        <i class="bi bi-shield-lock"></i>
        Secured with JWT authentication
      </div>
    </div>
  `;

  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const errorMsg = document.getElementById('login-error-msg');
  const loginBtn = document.getElementById('login-btn');
  const btnText = document.getElementById('login-btn-text');
  const spinner = document.getElementById('login-spinner');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (!username || !password) {
      showError('Please enter both username and password.');
      return;
    }

    // Loading state
    loginBtn.disabled = true;
    btnText.classList.add('hidden');
    spinner.classList.remove('hidden');
    errorBox.classList.add('hidden');

    try {
      const data = await api.login(username, password);
      onSuccess(data.username);
    } catch (err) {
      showError(err.message || 'Login failed. Please try again.');
      loginBtn.disabled = false;
      btnText.classList.remove('hidden');
      spinner.classList.add('hidden');
    }
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  // Focus username on load
  document.getElementById('login-username').focus();
}
