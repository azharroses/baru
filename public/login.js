async function initLoginPage() {
  await loadConfig();
  await initAuth();

  const form = document.querySelector('#loginForm');
  const message = document.querySelector('#loginMessage');

  if (!state.config.auth_enabled) {
    message.textContent = 'Login belum aktif. Isi SUPABASE_PUBLISHABLE_KEY di Render.';
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = 'Memproses login...';

    const email = document.querySelector('#loginEmail').value;
    const password = document.querySelector('#loginPassword').value;
    const { error } = await state.supabase.auth.signInWithPassword({ email, password });

    if (error) {
      message.textContent = error.message;
      return;
    }

    window.location.href = '/';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initLoginPage().catch(console.error);
});
