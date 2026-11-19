const API_BASE = 'http://localhost:5000/api';
const THEME_KEY = 'student-market-theme';

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
  if (!token) return null;

  try {
    const response = await fetch(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();

    if (response.status === 401) {
      localStorage.removeItem('student-market-token');
      localStorage.removeItem('student-market-user');
      return null;
    }

    if (!response.ok) return null;

    if (data.user) {
      localStorage.setItem('student-market-user', JSON.stringify(data.user));
    }
    return data.user || null;
  } catch (error) {
    return null;
  }
}

function updateAuthNav() {
  const authLink = document.getElementById('auth-link');
  const dashboardLink = document.getElementById('dashboard-link');
  const sellerLinks = document.querySelectorAll('a[href="sell.html"]');
  const token = localStorage.getItem('student-market-token');

  if (dashboardLink) {
    dashboardLink.classList.toggle('hidden-when-logged-out', !token);
  }

  sellerLinks.forEach((link) => {
    link.classList.add('hidden-when-logged-out');
  });

  if (!authLink) return;

  if (token) {
    authLink.textContent = 'Logout';
    authLink.href = '#';
    authLink.onclick = (event) => {
      event.preventDefault();
      localStorage.removeItem('student-market-token');
      localStorage.removeItem('student-market-user');
      if (dashboardLink) {
        dashboardLink.classList.add('hidden-when-logged-out');
      }
      sellerLinks.forEach((link) => {
        link.classList.add('hidden-when-logged-out');
      });
      window.location.href = 'index.html';
    };

    getCurrentUser().then((user) => {
      const isSeller = user?.role === 'seller';
      sellerLinks.forEach((link) => {
        link.classList.toggle('hidden-when-logged-out', !isSeller);
      });
    });
  } else {
    authLink.textContent = 'Login';
    authLink.href = 'login.html';
    authLink.onclick = null;
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-GH', {
    style: 'currency',
    currency: 'GHS',
    maximumFractionDigits: 0
  }).format(Number(value || 0));
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

    grid.innerHTML = data.listings.map((listing) => `
      <article class="card listing">
        <div class="thumb" aria-hidden></div>
        <div class="card-body">
          <h3>${listing.title}</h3>
          <p class="price">${formatCurrency(listing.price)}</p>
          <p class="meta">${listing.category} • ${listing.location || 'Campus pickup'} • ${listing.seller_name || 'Student seller'}</p>
          <p class="meta">${listing.description.slice(0, 80)}${listing.description.length > 80 ? '...' : ''}</p>
        </div>
      </article>
    `).join('');
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

    grid.innerHTML = data.listings.map((listing) => `
      <article class="card listing">
        <div class="thumb" aria-hidden></div>
        <div class="card-body">
          <h3>${listing.title}</h3>
          <p class="price">${formatCurrency(listing.price)}</p>
          <p class="meta">${listing.category} • ${listing.location || 'Campus pickup'} • ${listing.seller_name || 'Student seller'}</p>
        </div>
      </article>
    `).join('');
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

    grid.innerHTML = data.jobs.map((job) => `
      <article class="card listing">
        <div class="thumb" aria-hidden></div>
        <div class="card-body">
          <h3>${job.title}</h3>
          <p class="price">${job.company}</p>
          <p class="meta">${job.type} • ${job.location || 'Campus'}</p>
          <p class="meta">${job.description}</p>
        </div>
      </article>
    `).join('');
  } catch (error) {
    grid.innerHTML = '<article class="card listing"><div class="card-body"><h3>Jobs unavailable</h3><p class="meta">The backend may be offline.</p></div></article>';
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
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
    if (!response.ok) {
      throw new Error(data.message || 'Login failed');
    }

    localStorage.setItem('student-market-token', data.token);
    if (data.user) {
      localStorage.setItem('student-market-user', JSON.stringify(data.user));
    }
    setAuthStatus('Login successful. Redirecting to dashboard...');
    window.location.href = 'dashboard.html';
  } catch (error) {
    setAuthStatus(error.message || 'Unable to log in.', true);
  }
}

async function handleSignupSubmit(event) {
  event.preventDefault();
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
    if (!response.ok) {
      throw new Error(data.message || 'Signup failed');
    }

    localStorage.setItem('student-market-token', data.token);
    if (data.user) {
      localStorage.setItem('student-market-user', JSON.stringify(data.user));
    }
    setAuthStatus('Account created successfully. Redirecting to dashboard...');
    window.location.href = 'dashboard.html';
  } catch (error) {
    setAuthStatus(error.message || 'Unable to create account.', true);
  }
}

async function loadDashboardContent() {
  const listingContainer = document.getElementById('dashboard-listings');
  const activityContainer = document.getElementById('dashboard-activity');
  const titleElement = document.querySelector('.dashboard-hero h1');
  const metaElement = document.getElementById('dashboard-user-meta');
  const roleBadges = document.getElementById('dashboard-role-badges');
  const totalSalesElement = document.querySelectorAll('.stat-card strong')[0];
  const activeListingsElement = document.querySelectorAll('.stat-card strong')[1];
  const ordersPlacedElement = document.querySelectorAll('.stat-card strong')[2];
  const walletElement = document.querySelectorAll('.stat-card strong')[3];

  if (!listingContainer || !activityContainer) return;

  const token = localStorage.getItem('student-market-token');
  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 401) {
      localStorage.removeItem('student-market-token');
      localStorage.removeItem('student-market-user');
      if (listingContainer) listingContainer.innerHTML = '';
      if (activityContainer) activityContainer.innerHTML = '';
      if (roleBadges) roleBadges.innerHTML = '';
      const addListingLink = document.getElementById('dashboard-add-listing');
      if (addListingLink) addListingLink.classList.add('hidden-when-logged-out');
      const existingUpgrade = document.getElementById('become-seller-action');
      if (existingUpgrade) existingUpgrade.remove();
      window.location.href = 'login.html';
      return;
    }

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || 'Dashboard fetch failed');
    }

    const { user, listings, stats, activity } = data;
    const storedUser = JSON.parse(localStorage.getItem('student-market-user') || '{}');
    const safeUser = user || storedUser;

    if (safeUser) {
      localStorage.setItem('student-market-user', JSON.stringify(safeUser));
    }

    if (titleElement) {
      titleElement.textContent = `Welcome back, ${safeUser?.name?.split(' ')[0] || 'Student'}`;
    }

    if (metaElement) {
      metaElement.textContent = `${safeUser?.email || 'student@campus.edu'} • ${safeUser?.role || 'student'}`;
    }

    if (roleBadges) {
      const role = String(safeUser?.role || '').toLowerCase();
      roleBadges.innerHTML = role === 'seller'
        ? '<span class="badge badge-seller">Seller</span>'
        : role === 'buyer'
          ? '<span class="badge badge-buyer">Buyer</span>'
          : '';
    }

    const addListingLink = document.getElementById('dashboard-add-listing');
    if (addListingLink) {
      addListingLink.classList.toggle('hidden-when-logged-out', safeUser?.role !== 'seller');
    }

    const existingUpgrade = document.getElementById('become-seller-action');
    if (existingUpgrade) existingUpgrade.remove();

    if (safeUser?.role === 'buyer') {
      const hero = document.querySelector('.dashboard-hero');
      if (hero) {
        const upgradeSection = document.createElement('div');
        upgradeSection.className = 'role-badges';
        upgradeSection.id = 'become-seller-action';
        upgradeSection.innerHTML = `
          <button type="button" class="badge badge-seller" id="upgrade-seller-button">Become a Seller</button>
          <span id="upgrade-seller-status" class="form-status" aria-live="polite"></span>
        `;
        hero.appendChild(upgradeSection);

        document.getElementById('upgrade-seller-button')?.addEventListener('click', handleUpgradeToSeller);
      }
    }

    if (totalSalesElement) totalSalesElement.textContent = formatCurrency(stats.totalSales || 0);
    if (activeListingsElement) activeListingsElement.textContent = String(stats.activeListings || 0);
    if (ordersPlacedElement) ordersPlacedElement.textContent = String(stats.ordersPlaced || 0);
    if (walletElement) walletElement.textContent = formatCurrency(stats.walletBalance || 0);

    listingContainer.innerHTML = (listings && listings.length ? listings : []).map((item) => `
      <div class="listing-mini">
        <strong>${item.title}</strong>
        <span>${formatCurrency(item.price)}</span>
        <small>${item.status || 'Active'} • ${item.category || 'General'}</small>
      </div>
    `).join('') || '<div class="listing-mini"><strong>No listings yet</strong><small>List your first item to get started.</small></div>';

    activityContainer.innerHTML = (activity || []).map((item) => `
      <div class="activity-item">
        <p>${item.text}</p>
        <small>${item.time}</small>
      </div>
    `).join('');
  } catch (error) {
    console.error(error);
    if (listingContainer) {
      listingContainer.innerHTML = '<div class="listing-mini"><strong>Dashboard unavailable</strong><small>Please try again in a moment.</small></div>';
    }
    if (activityContainer) {
      activityContainer.innerHTML = '<div class="activity-item"><p>Unable to load your recent activity.</p><small>Please refresh.</small></div>';
    }
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

    if (response.status === 401) {
      localStorage.removeItem('student-market-token');
      localStorage.removeItem('student-market-user');
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
    if (status) {
      status.textContent = error.message || 'Unable to upgrade account.';
      status.style.color = '#b91c1c';
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
    if (response.status === 401) {
      localStorage.removeItem('student-market-token');
      localStorage.removeItem('student-market-user');
      window.location.href = 'login.html';
      return;
    }
    if (response.status === 403) {
      throw new Error(data.message || 'A Seller account is required to create listings.');
    }
    if (!response.ok) {
      throw new Error(data.message || 'Listing failed');
    }

    status.textContent = 'Listing created successfully.';
    status.style.color = '#166534';
    form.reset();
  } catch (error) {
    status.textContent = error.message || 'Unable to create listing.';
    status.style.color = '#b91c1c';
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
    const token = localStorage.getItem('student-market-token');
    if (!token) {
      window.location.href = 'login.html';
    } else {
      getCurrentUser().then((user) => {
        if (!user) {
          window.location.href = 'login.html';
          return;
        }
        if (user.role !== 'seller') {
          sellForm.hidden = true;
          const status = document.getElementById('sell-status');
          if (status) status.textContent = 'A Seller account is required to create listings.';
          return;
        }
        sellForm.addEventListener('submit', handleSellSubmit);
      });
    }
  }

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }

  const signupForm = document.getElementById('signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', handleSignupSubmit);
  }

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
