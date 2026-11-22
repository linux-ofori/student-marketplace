const API_BASE = 'http://localhost:5000/api';
const THEME_KEY = 'student-market-theme';
let authRequestSequence = 0;
let currentUserRequest = null;
let dashboardRequestSequence = 0;
let authenticationAttemptSequence = 0;

function beginAuthenticationAttempt() {
  authenticationAttemptSequence += 1;
  return authenticationAttemptSequence;
}

function isCurrentAuthenticationAttempt(attemptId) {
  return authenticationAttemptSequence === attemptId;
}

function setAuthStatus(message, isError = false) {
  const status = document.getElementById('auth-status');
  if (!status) return;
  status.textContent = message;
  status.style.color = isError ? '#b91c1c' : '#166534';
}

function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.body.classList.toggle('dark-theme', isDark);

  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  const icon = toggle.querySelector('.theme-toggle-icon');
  const label = toggle.querySelector('.theme-toggle-text');

  if (icon) {
    icon.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"></circle><g stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2.5 12h2.2M19.3 12h2.2M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"/></g></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A7.5 7.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z" fill="currentColor" stroke="none"></path></svg>';
  }

  if (label) {
    label.textContent = isDark ? 'Light' : 'Dark';
  }

  if (toggle) {
    toggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}

function initThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(savedTheme);

  toggle.addEventListener('click', () => {
    const nextTheme = document.body.classList.contains('dark-theme') ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, nextTheme);
    applyTheme(nextTheme);
  });
}

async function getCurrentUser() {
  const token = localStorage.getItem('student-market-token');
  if (!token) return { token: null, user: null, unauthorized: true, stale: false };
  if (currentUserRequest?.token === token) return currentUserRequest.promise;

  const requestId = ++authRequestSequence;
  const request = { token, requestId, promise: null };
  request.promise = (async () => {
    const isCurrentRequest = () =>
      localStorage.getItem('student-market-token') === token &&
      currentUserRequest?.requestId === requestId;

    try {
      const response = await fetch(`${API_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();

      if (!isCurrentRequest()) return { token, user: null, stale: true };

      if (response.status === 401) {
        clearAuthenticationState(token);
        return { token, user: null, unauthorized: true, stale: false };
      }

      if (!response.ok) {
        throw new Error(data.message || 'Unable to verify account right now.');
      }

      if (!isCurrentRequest()) return { token, user: null, stale: true };
      if (data.user) {
        localStorage.setItem('student-market-user', JSON.stringify(data.user));
      }
      return { token, user: data.user || null, stale: false };
    } catch (error) {
      if (!isCurrentRequest()) return { token, user: null, stale: true };
      throw error;
    } finally {
      if (currentUserRequest?.requestId === requestId) currentUserRequest = null;
    }
  })();
  currentUserRequest = request;
  return request.promise;
}

function clearAuthenticationState(expectedToken) {
  if (expectedToken !== undefined && localStorage.getItem('student-market-token') !== expectedToken) {
    return false;
  }
  localStorage.removeItem('student-market-token');
  localStorage.removeItem('student-market-user');
  updateAuthNav();
  return true;
}

function updateAuthNav() {
  const authLink = document.getElementById('auth-link');
  const dashboardLink = document.getElementById('dashboard-link');
  const sellerLinks = document.querySelectorAll('a[href="sell.html"]');
  const token = localStorage.getItem('student-market-token');

  if (dashboardLink) {
    dashboardLink.classList.add('hidden-when-logged-out');
  }

  sellerLinks.forEach((link) => {
    link.classList.add('hidden-when-logged-out');
  });

  if (!authLink) return;

  authLink.textContent = 'Login';
  authLink.href = 'login.html';
  authLink.onclick = null;

  if (!token) return;

  getCurrentUser().then((authState) => {
    if (
      authState.stale ||
      authState.token !== token ||
      localStorage.getItem('student-market-token') !== token ||
      !authState.user
    ) return;

    authLink.textContent = 'Logout';
    authLink.href = '#';
    authLink.onclick = (event) => {
      event.preventDefault();
      beginAuthenticationAttempt();
      clearAuthenticationState();
      window.location.href = 'index.html';
    };

    if (dashboardLink) dashboardLink.classList.remove('hidden-when-logged-out');
    const isSeller = authState.user.role === 'seller';
    sellerLinks.forEach((link) => {
      link.classList.toggle('hidden-when-logged-out', !isSeller);
    });
  }).catch(() => {});
}

function verifySellPageAccess(sellForm) {
  const token = localStorage.getItem('student-market-token');
  const status = document.getElementById('sell-status');
  sellForm.hidden = true;

  if (!token) {
    if (status) status.textContent = 'Please log in to access the Sell page.';
    window.location.href = 'login.html';
    return;
  }

  getCurrentUser().then((authState) => {
    const currentToken = localStorage.getItem('student-market-token');
    if (authState.stale || authState.token !== token || currentToken !== token) {
      sellForm.hidden = true;
      if (currentToken) verifySellPageAccess(sellForm);
      else window.location.href = 'login.html';
      return;
    }

    if (!authState.user) {
      sellForm.hidden = true;
      if (status) status.textContent = 'Please log in to access the Sell page.';
      window.location.href = 'login.html';
      return;
    }

    if (authState.user.role !== 'seller') {
      sellForm.hidden = true;
      if (status) status.textContent = 'A Seller account is required to create listings.';
      return;
    }

    sellForm.hidden = false;
    if (status) status.textContent = '';
    if (sellForm.dataset.submitListenerAttached !== 'true') {
      sellForm.addEventListener('submit', handleSellSubmit);
      sellForm.dataset.submitListenerAttached = 'true';
    }
  }).catch((error) => {
    if (localStorage.getItem('student-market-token') !== token) {
      sellForm.hidden = true;
      if (localStorage.getItem('student-market-token')) verifySellPageAccess(sellForm);
      else window.location.href = 'login.html';
      return;
    }

    sellForm.hidden = true;
    if (status) {
      status.textContent = error.message || 'Unable to verify your account. Please try again.';
      status.style.color = '#b91c1c';
    }
  });
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-GH', {
    style: 'currency',
    currency: 'GHS',
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function createTextElement(tagName, className, value) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(value ?? '');
  return element;
}

function createMarketplaceListingCard(listing) {
  const article = document.createElement('article');
  article.className = 'card listing';

  const thumbnail = document.createElement('div');
  thumbnail.className = 'thumb';
  thumbnail.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'card-body';
  body.append(
    createTextElement('h3', '', listing.title),
    createTextElement('p', 'price', formatCurrency(listing.price)),
    createTextElement(
      'p',
      'meta',
      `${listing.category || 'General'} • ${listing.location || 'Campus pickup'} • ${listing.seller_name || 'Student seller'}`
    )
  );

  const description = String(listing.description || '');
  body.append(createTextElement('p', 'meta', `${description.slice(0, 80)}${description.length > 80 ? '...' : ''}`));
  article.append(thumbnail, body);
  return article;
}

function renderMarketplaceListings(grid, listings) {
  grid.replaceChildren(...listings.map(createMarketplaceListingCard));
}

function createDashboardListing(item) {
  const listing = document.createElement('div');
  listing.className = 'listing-mini';
  listing.append(
    createTextElement('strong', '', item.title),
    createTextElement('span', '', formatCurrency(item.price)),
    createTextElement('small', '', `${item.status || 'Active'} • ${item.category || 'General'}`)
  );

  const actions = document.createElement('div');
  actions.className = 'listing-actions';
  const editButton = createTextElement('button', '', 'Edit');
  editButton.type = 'button';
  editButton.addEventListener('click', () => listing.replaceWith(createListingEditor(item)));
  const deleteButton = createTextElement('button', 'listing-delete', 'Delete');
  deleteButton.type = 'button';
  deleteButton.addEventListener('click', () => deleteDashboardListing(item, listing));
  actions.append(editButton, deleteButton);
  listing.append(actions);
  return listing;
}

function createListingEditor(item) {
  const form = document.createElement('form');
  form.className = 'listing-mini listing-edit-form';

  const addInput = (labelText, name, type, value, options = {}) => {
    const label = createTextElement('label', options.className || '', labelText);
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.name = name;
    input.value = value ?? '';
    if (options.required) input.required = true;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.min !== undefined) input.min = String(options.min);
    if (options.step) input.step = options.step;
    label.append(input);
    form.append(label);
  };

  const addSelect = (labelText, name, value, choices) => {
    const label = createTextElement('label', '', labelText);
    const select = document.createElement('select');
    select.name = name;
    select.required = true;
    choices.forEach(([choiceValue, choiceLabel]) => {
      const option = createTextElement('option', '', choiceLabel);
      option.value = choiceValue;
      option.selected = choiceValue === value;
      select.append(option);
    });
    label.append(select);
    form.append(label);
  };

  addInput('Title', 'title', 'text', item.title, { required: true, maxLength: 120 });
  addInput('Price', 'price', 'number', item.price, { required: true, min: 0.01, step: '0.01' });
  addInput('Category', 'category', 'text', item.category, { required: true, maxLength: 60 });
  addSelect('Condition', 'condition', item.condition, [
    ['Excellent', 'Excellent'], ['Good', 'Good'], ['Fair', 'Fair'], ['Poor', 'Poor']
  ]);
  addSelect('Delivery mode', 'deliveryMode', item.delivery_mode, [
    ['pickup', 'Campus pickup'], ['delivery', 'Delivery']
  ]);
  addInput('Location', 'location', 'text', item.location, { maxLength: 120 });
  addInput('Description', 'description', 'textarea', item.description, {
    required: true,
    maxLength: 2000,
    className: 'edit-description'
  });

  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const saveButton = createTextElement('button', '', 'Save changes');
  saveButton.type = 'submit';
  const cancelButton = createTextElement('button', '', 'Cancel');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', loadDashboardContent);
  actions.append(saveButton, cancelButton);
  form.append(actions);
  form.addEventListener('submit', (event) => saveDashboardListing(event, item, form));
  return form;
}

function setDashboardStatus(message, isError = false) {
  const status = document.getElementById('dashboard-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('dashboard-status-error', isError);
}

async function getDashboardErrorMessage(response) {
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  const details = Array.isArray(data.errors) ? ` ${data.errors.join(' ')}` : '';
  if (response.status === 403) return data.message || 'You can only manage your own listings.';
  if (response.status === 404) return data.message || 'This listing no longer exists. Refresh the dashboard.';
  return `${data.message || 'The request could not be completed.'}${details}`;
}

async function saveDashboardListing(event, item, form) {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const token = localStorage.getItem('student-market-token');
  if (!token) {
    clearAuthenticationState();
    window.location.href = 'login.html';
    return;
  }

  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  setDashboardStatus('Saving listing...');

  const location = form.elements.location.value.trim();
  const payload = {
    title: form.elements.title.value.trim(),
    price: Number(form.elements.price.value),
    category: form.elements.category.value.trim(),
    condition: form.elements.condition.value,
    deliveryMode: form.elements.deliveryMode.value,
    description: form.elements.description.value.trim()
  };
  if (location) payload.location = location;

  try {
    const response = await fetch(`${API_BASE}/listings/${item.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (localStorage.getItem('student-market-token') !== token) {
      loadDashboardContent();
      return;
    }
    if (response.status === 401) {
      clearAuthenticationState(token);
      window.location.href = 'login.html';
      return;
    }
    if (!response.ok) throw new Error(await getDashboardErrorMessage(response));

    await loadDashboardContent();
    if (localStorage.getItem('student-market-token') === token) {
      setDashboardStatus('Listing updated successfully.');
    }
  } catch (error) {
    if (localStorage.getItem('student-market-token') === token) {
      setDashboardStatus(error.message || 'Unable to update listing.', true);
    } else {
      loadDashboardContent();
    }
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function deleteDashboardListing(item, listingElement) {
  if (!window.confirm(`Permanently delete "${item.title}"? This cannot be undone.`)) return;

  const token = localStorage.getItem('student-market-token');
  if (!token) {
    clearAuthenticationState();
    window.location.href = 'login.html';
    return;
  }

  const buttons = [...listingElement.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  setDashboardStatus('Deleting listing...');

  try {
    const response = await fetch(`${API_BASE}/listings/${item.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    if (localStorage.getItem('student-market-token') !== token) {
      loadDashboardContent();
      return;
    }
    if (response.status === 401) {
      clearAuthenticationState(token);
      window.location.href = 'login.html';
      return;
    }
    if (!response.ok) throw new Error(await getDashboardErrorMessage(response));

    await loadDashboardContent();
    if (localStorage.getItem('student-market-token') === token) {
      setDashboardStatus('Listing deleted successfully.');
    }
  } catch (error) {
    if (localStorage.getItem('student-market-token') === token) {
      setDashboardStatus(error.message || 'Unable to delete listing.', true);
    } else {
      loadDashboardContent();
    }
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function loadListings() {
  const grid = document.getElementById('listings-grid');
  if (!grid) return;

  try {
    const response = await fetch(`${API_BASE}/listings`);
    const data = await response.json();

    if (!response.ok || !Array.isArray(data.listings)) {
      throw new Error(data.message || 'Unable to load listings');
    }

    if (!data.listings.length) {
      grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>No listings found</h3><p class="meta">Try a different search term.</p></div></article>';
      return;
    }

    renderMarketplaceListings(grid, data.listings);
  } catch (error) {
    grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>Listings unavailable</h3><p class="meta">The backend may be offline.</p></div></article>';
  }
}

async function handleSearch(event) {
  event.preventDefault();
  const input = document.getElementById('search-input');
  const term = input ? input.value.trim() : '';

  const grid = document.getElementById('listings-grid');
  if (!grid) return;

  try {
    const url = term ? `${API_BASE}/listings?q=${encodeURIComponent(term)}` : `${API_BASE}/listings`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || !Array.isArray(data.listings)) {
      throw new Error(data.message || 'Search failed');
    }

    if (!data.listings.length) {
      grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>No results</h3><p class="meta">Try another keyword.</p></div></article>';
      return;
    }

    renderMarketplaceListings(grid, data.listings);
  } catch (error) {
    grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>Search failed</h3><p class="meta">Please try again.</p></div></article>';
  }
}

async function handleContactSubmit(event) {
  event.preventDefault();
  const status = document.getElementById('contact-status');
  if (!status) return;

  const form = event.currentTarget;
  const payload = {
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    message: form.message.value.trim()
  };

  try {
    const response = await fetch(`${API_BASE}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || 'Submission failed');
    }

    status.textContent = 'Message sent successfully. We will be in touch soon.';
    status.style.color = '#166534';
    form.reset();
  } catch (error) {
    status.textContent = error.message || 'Unable to send message right now.';
    status.style.color = '#b91c1c';
  }
}

async function loadJobs() {
  const grid = document.getElementById('jobs-grid');
  if (!grid) return;

  try {
    const response = await fetch(`${API_BASE}/jobs`);
    const data = await response.json();

    if (!response.ok || !Array.isArray(data.jobs)) {
      throw new Error(data.message || 'Unable to load jobs');
    }

    if (!data.jobs.length) {
      grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>No jobs posted yet</h3><p class="meta">Check back soon.</p></div></article>';
      return;
    }

    const jobCards = data.jobs.map((job) => {
      const article = document.createElement('article');
      article.className = 'card listing';

      const thumbnail = document.createElement('div');
      thumbnail.className = 'thumb';
      thumbnail.setAttribute('aria-hidden', 'true');

      const body = document.createElement('div');
      body.className = 'card-body';
      body.append(
        createTextElement('h3', '', job.title),
        createTextElement('p', 'price', job.company),
        createTextElement('p', 'meta', `${job.type} • ${job.location || 'Campus'}`),
        createTextElement('p', 'meta', job.description)
      );

      article.append(thumbnail, body);
      return article;
    });
    grid.replaceChildren(...jobCards);
  } catch (error) {
    grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>Jobs unavailable</h3><p class="meta">The backend may be offline.</p></div></article>';
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const attemptId = beginAuthenticationAttempt();
  const form = event.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    if (!isCurrentAuthenticationAttempt(attemptId)) return;
    if (!response.ok) {
      throw new Error(data.message || 'Login failed');
    }

    if (!isCurrentAuthenticationAttempt(attemptId)) return;
    localStorage.setItem('student-market-token', data.token);
    if (data.user) {
      localStorage.setItem('student-market-user', JSON.stringify(data.user));
    }
    setAuthStatus('Login successful. Redirecting to dashboard...');
    window.location.href = 'dashboard.html';
  } catch (error) {
    if (isCurrentAuthenticationAttempt(attemptId)) {
      setAuthStatus(error.message || 'Unable to log in.', true);
    }
  }
}

async function handleSignupSubmit(event) {
  event.preventDefault();
  const attemptId = beginAuthenticationAttempt();
  const form = event.currentTarget;
  const payload = {
    name: form.name.value.trim(),
    email: form.email.value.trim(),
    password: form.password.value,
    role: form.role.value
  };

  try {
    const response = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!isCurrentAuthenticationAttempt(attemptId)) return;
    if (!response.ok) {
      throw new Error(data.message || 'Signup failed');
    }

    if (!isCurrentAuthenticationAttempt(attemptId)) return;
    localStorage.setItem('student-market-token', data.token);
    if (data.user) {
      localStorage.setItem('student-market-user', JSON.stringify(data.user));
    }
    setAuthStatus('Account created successfully. Redirecting to dashboard...');
    window.location.href = 'dashboard.html';
  } catch (error) {
    if (isCurrentAuthenticationAttempt(attemptId)) {
      setAuthStatus(error.message || 'Unable to create account.', true);
    }
  }
}

async function loadDashboardContent() {
  const requestId = ++dashboardRequestSequence;
  const listingContainer = document.getElementById('dashboard-listings');
  const activityContainer = document.getElementById('dashboard-activity');
  const titleElement = document.querySelector('.dashboard-hero h1');
  const metaElement = document.getElementById('dashboard-user-meta');
  const roleBadges = document.getElementById('dashboard-role-badges');
  const listingPanel = document.getElementById('seller-listings-panel');
  const statsGrid = document.getElementById('dashboard-stats');
  const retryButton = document.getElementById('dashboard-retry');
  const dashboardLayout = document.querySelector('.dashboard-layout');

  if (!listingContainer || !activityContainer) return;

  const token = localStorage.getItem('student-market-token');
  const clearDashboardData = () => {
    listingContainer.replaceChildren();
    activityContainer.replaceChildren();
    if (roleBadges) roleBadges.replaceChildren();
    if (titleElement) titleElement.textContent = 'Welcome back, Student';
    if (metaElement) metaElement.textContent = 'Loading profile...';
    if (listingPanel) listingPanel.hidden = true;
    if (statsGrid) statsGrid.hidden = true;
    const addListingLink = document.getElementById('dashboard-add-listing');
    if (addListingLink) addListingLink.classList.add('hidden-when-logged-out');
    const existingUpgrade = document.getElementById('become-seller-action');
    if (existingUpgrade) existingUpgrade.remove();
  };
  const discardIfStale = () => {
    if (requestId !== dashboardRequestSequence) return true;
    if (localStorage.getItem('student-market-token') === token) return false;

    clearDashboardData();
    if (localStorage.getItem('student-market-token')) loadDashboardContent();
    else window.location.href = 'login.html';
    return true;
  };

  if (listingPanel) listingPanel.hidden = true;
  if (statsGrid) statsGrid.hidden = true;
  if (retryButton) retryButton.hidden = true;
  clearDashboardData();
  setDashboardStatus('Loading dashboard...');

  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (discardIfStale()) return;
    if (response.status === 401) {
      clearAuthenticationState(token);
      clearDashboardData();
      window.location.href = 'login.html';
      return;
    }

    const data = await response.json();
    if (discardIfStale()) return;
    if (!response.ok) {
      throw new Error(data.message || 'Dashboard fetch failed');
    }

    const { user, listings, activity } = data;
    if (!user || !Array.isArray(listings)) throw new Error('Dashboard response is incomplete.');
    const currentUser = user;
    localStorage.setItem('student-market-user', JSON.stringify(currentUser));

    if (titleElement) {
      titleElement.textContent = `Welcome back, ${currentUser.name?.split(' ')[0] || 'Student'}`;
    }

    if (metaElement) {
      metaElement.textContent = `${currentUser.email || 'student@campus.edu'} • ${currentUser.role || 'buyer'}`;
    }

    if (roleBadges) {
      roleBadges.replaceChildren();
      if (currentUser.role === 'seller') {
        roleBadges.append(createTextElement('span', 'badge badge-seller', 'Seller'));
      } else if (currentUser.role === 'buyer') {
        roleBadges.append(createTextElement('span', 'badge badge-buyer', 'Buyer'));
      }
    }

    const addListingLink = document.getElementById('dashboard-add-listing');
    const isSeller = currentUser.role === 'seller';
    if (listingPanel) listingPanel.hidden = !isSeller;
    if (statsGrid) statsGrid.hidden = !isSeller;
    if (addListingLink) addListingLink.classList.toggle('hidden-when-logged-out', !isSeller);
    if (dashboardLayout) dashboardLayout.classList.toggle('buyer-dashboard', !isSeller);

    const totalListingsElement = document.getElementById('dashboard-total-listings');
    const activeListingsElement = document.getElementById('dashboard-active-listings');
    if (totalListingsElement) totalListingsElement.textContent = String(listings.length);
    if (activeListingsElement) {
      activeListingsElement.textContent = String(listings.filter((item) => item.status === 'active').length);
    }

    const existingUpgrade = document.getElementById('become-seller-action');
    if (existingUpgrade) existingUpgrade.remove();

    if (currentUser.role === 'buyer') {
      const hero = document.querySelector('.dashboard-hero');
      if (hero) {
        const upgradeSection = document.createElement('div');
        upgradeSection.className = 'role-badges';
        upgradeSection.id = 'become-seller-action';
        const upgradeButton = createTextElement('button', 'badge badge-seller', 'Become a Seller');
        upgradeButton.type = 'button';
        upgradeButton.id = 'upgrade-seller-button';
        const upgradeStatus = document.createElement('span');
        upgradeStatus.className = 'form-status';
        upgradeStatus.id = 'upgrade-seller-status';
        upgradeStatus.setAttribute('aria-live', 'polite');
        upgradeSection.append(upgradeButton, upgradeStatus);
        hero.appendChild(upgradeSection);

        document.getElementById('upgrade-seller-button')?.addEventListener('click', handleUpgradeToSeller);
      }
    }

    if (isSeller && listings.length) {
      listings.forEach((item) => listingContainer.append(createDashboardListing(item)));
    } else if (isSeller) {
      const emptyState = document.createElement('div');
      emptyState.className = 'listing-mini';
      emptyState.append(
        createTextElement('strong', '', 'No listings yet'),
        createTextElement('small', '', 'List your first item to get started.')
      );
      listingContainer.append(emptyState);
    }

    activityContainer.replaceChildren();
    if (activity && activity.length) activity.forEach((item) => {
      const activityEntry = document.createElement('div');
      activityEntry.className = 'activity-item';
      activityEntry.append(
        createTextElement('p', '', item.text),
        createTextElement('small', '', item.time)
      );
      activityContainer.append(activityEntry);
    });
    else activityContainer.append(createTextElement('p', 'meta', 'No recent activity.'));
    setDashboardStatus('');
  } catch (error) {
    if (discardIfStale()) return;
    console.error(error);
    if (listingContainer) listingContainer.replaceChildren();
    if (activityContainer) activityContainer.replaceChildren();
    if (listingPanel) listingPanel.hidden = true;
    if (statsGrid) statsGrid.hidden = true;
    setDashboardStatus(error.message || 'Dashboard unavailable. Please try again.', true);
    if (retryButton) retryButton.hidden = false;
  } finally {
    if (retryButton && requestId === dashboardRequestSequence) retryButton.disabled = false;
  }
}

async function handleUpgradeToSeller(event) {
  event.preventDefault();
  const button = event.currentTarget;
  const status = document.getElementById('upgrade-seller-status');
  const token = localStorage.getItem('student-market-token');

  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  if (button) button.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/users/me/upgrade-to-seller`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();

    if (localStorage.getItem('student-market-token') !== token) {
      loadDashboardContent();
      return;
    }
    if (response.status === 401) {
      clearAuthenticationState(token);
      window.location.href = 'login.html';
      return;
    }

    if (!response.ok) {
      throw new Error(data.message || 'Unable to upgrade account.');
    }

    if (data.token) {
      localStorage.setItem('student-market-token', data.token);
    }
    if (data.user) {
      localStorage.setItem('student-market-user', JSON.stringify(data.user));
    }

    if (status) {
      status.textContent = data.message || 'Account upgraded to Seller.';
      status.style.color = '#166534';
    }

    updateAuthNav();
    await loadDashboardContent();
  } catch (error) {
    if (localStorage.getItem('student-market-token') === token && status) {
      status.textContent = error.message || 'Unable to upgrade account.';
      status.style.color = '#b91c1c';
    } else if (localStorage.getItem('student-market-token') !== token) {
      loadDashboardContent();
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleSellSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById('sell-status');
  if (!status) return;
  if (form.dataset.submitting === 'true') return;

  const token = localStorage.getItem('student-market-token');
  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  const priceText = form.price.value.trim();
  const price = Number(priceText);
  if (!priceText || !Number.isFinite(price) || price <= 0) {
    status.textContent = 'Enter a valid price greater than 0.';
    status.style.color = '#b91c1c';
    form.price.focus();
    return;
  }

  const payload = {
    title: form.title.value.trim(),
    price,
    category: form.category.value.trim(),
    location: form.location.value.trim(),
    description: form.description.value.trim(),
    condition: form.condition.value,
    deliveryMode: form.deliveryMode.value
  };

  const submitButton = form.querySelector('button[type="submit"]');
  form.dataset.submitting = 'true';
  if (submitButton) submitButton.disabled = true;
  status.textContent = 'Publishing listing...';
  status.style.color = '';

  try {
    const response = await fetch(`${API_BASE}/listings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (localStorage.getItem('student-market-token') !== token) {
      verifySellPageAccess(form);
      return;
    }
    if (response.status === 401) {
      if (clearAuthenticationState(token)) window.location.href = 'login.html';
      else verifySellPageAccess(form);
      return;
    }
    if (response.status === 403) {
      throw new Error(data.message || 'A Seller account is required to create listings.');
    }
    if (!response.ok) {
      const details = Array.isArray(data.errors) ? ` ${data.errors.join(' ')}` : '';
      throw new Error(`${data.message || 'Listing failed.'}${details}`);
    }

    status.textContent = 'Listing created successfully. Opening the marketplace...';
    status.style.color = '#166534';
    window.location.href = 'index.html';
  } catch (error) {
    if (localStorage.getItem('student-market-token') === token) {
      status.textContent = error.message || 'Unable to create listing.';
      status.style.color = '#b91c1c';
    } else {
      verifySellPageAccess(form);
    }
  } finally {
    form.dataset.submitting = 'false';
    if (submitButton) submitButton.disabled = false;
  }
}

function initPage() {
  const searchForm = document.getElementById('search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', handleSearch);
  }

  const contactForm = document.getElementById('contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', handleContactSubmit);
  }

  const sellForm = document.getElementById('sell-form');
  if (sellForm) {
    verifySellPageAccess(sellForm);
  }

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }

  const signupForm = document.getElementById('signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', handleSignupSubmit);
  }

  const dashboardRetry = document.getElementById('dashboard-retry');
  if (dashboardRetry) {
    dashboardRetry.addEventListener('click', loadDashboardContent);
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== 'student-market-token') return;
    beginAuthenticationAttempt();
    updateAuthNav();

    const currentSellForm = document.getElementById('sell-form');
    if (currentSellForm) {
      currentSellForm.hidden = true;
      verifySellPageAccess(currentSellForm);
    }

    if (document.getElementById('dashboard-listings')) loadDashboardContent();
  });

  initThemeToggle();
  updateAuthNav();

  if (document.getElementById('listings-grid')) {
    loadListings();
  }

  if (document.getElementById('jobs-grid')) {
    loadJobs();
  }

  if (document.getElementById('dashboard-listings')) {
    loadDashboardContent();
  }
}

document.addEventListener('DOMContentLoaded', initPage);
