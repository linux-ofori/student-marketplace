const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

let serverProcess;
let port;
let baseUrl;
let testDir;
let dbPath;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const selectedPort = socket.address().port;
      socket.close(() => resolve(selectedPort));
    });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        JWT_SECRET: 'isolated-api-test-secret',
        STUDENT_MARKET_DB_PATH: dbPath
      },
      stdio: 'ignore'
    });

    serverProcess.once('error', reject);

    const startedAt = Date.now();
    const poll = () => {
      request('/api/health').then((response) => {
        if (response.status === 200) {
          resolve();
        } else if (Date.now() - startedAt > 5000) {
          reject(new Error('Test server did not become healthy.'));
        } else {
          setTimeout(poll, 50);
        }
      }).catch(() => {
        if (Date.now() - startedAt > 5000) {
          reject(new Error('Test server did not start.'));
        } else {
          setTimeout(poll, 50);
        }
      });
    };
    poll();
  });
}

function stopServer() {
  if (!serverProcess) return Promise.resolve();
  return new Promise((resolve) => {
    serverProcess.once('exit', () => resolve());
    serverProcess.kill();
  });
}

function request(requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...(options.headers || {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    };

    const req = http.request(`${baseUrl}${requestPath}`, {
      method: options.method || 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (error) {
          return reject(new Error(`Invalid JSON response: ${data}`));
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function signup(name, email, role) {
  return request('/api/auth/signup', {
    method: 'POST',
    body: { name, email, password: 'student123', role }
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.run(sql, params, function (error) {
      db.close();
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.get(sql, params, (error, row) => {
      db.close();
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function run() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'student-marketplace-test-'));
  dbPath = path.join(testDir, 'test.db');
  port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;

  await startServer();

  const health = await request('/api/health');
  assert(health.status === 200, 'Health endpoint failed');

  const buyer = await signup('Test Buyer', 'buyer@example.com', 'buyer');
  assert(buyer.status === 201, 'Buyer signup failed');
  assert(buyer.body.user.role === 'buyer', 'Buyer role was not stored');

  const seller = await signup('Test Seller', 'seller@campus.edu', 'seller');
  assert(seller.status === 201, 'Seller signup failed');
  assert(seller.body.user.role === 'seller', 'Seller role was not stored');

  const secondSeller = await signup('Second Seller', 'second@campus.edu', 'seller');
  assert(secondSeller.status === 201, 'Second seller signup failed');

  const bodySecurityBuyer = await signup('Body Security Buyer', 'body-security@example.com', 'buyer');
  assert(bodySecurityBuyer.status === 201, 'Body-security Buyer signup failed');

  for (const invalidRole of [undefined, 'student', 'admin', 'Buyer', 'SELLER']) {
    const response = await signup(`Invalid ${invalidRole}`, `invalid_${String(invalidRole)}@example.com`, invalidRole);
    assert(response.status === 400, `Invalid role '${invalidRole}' was not rejected`);
  }

  const duplicate = await signup('Duplicate Buyer', 'buyer@example.com', 'buyer');
  assert(duplicate.status === 409, 'Duplicate email was not rejected');

  const unauthCreate = await request('/api/listings', {
    method: 'POST',
    body: { title: 'Unauthorized', description: 'No token', category: 'Other', price: 10, condition: 'Good', deliveryMode: 'pickup' }
  });
  assert(unauthCreate.status === 401, 'Unauthenticated listing creation was not rejected');

  const buyerCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { title: 'Buyer Listing', description: 'Blocked', category: 'Other', price: 10, condition: 'Good', deliveryMode: 'pickup' }
  });
  assert(buyerCreate.status === 403, 'Buyer listing creation was not rejected');

  const buyerUpdate = await request('/api/listings/1', {
    method: 'PUT',
    headers: authHeader(buyer.body.token),
    body: { title: 'Blocked update' }
  });
  assert(buyerUpdate.status === 403, 'Buyer listing update was not rejected');

  const buyerDelete = await request('/api/listings/1', {
    method: 'DELETE',
    headers: authHeader(buyer.body.token)
  });
  assert(buyerDelete.status === 403, 'Buyer listing delete was not rejected');

  const ownCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(seller.body.token),
    body: { title: 'Seller Item', description: 'Own listing', category: 'Textbooks', price: 25, condition: 'Good', deliveryMode: 'pickup', location: 'Campus' }
  });
  assert(ownCreate.status === 201, 'Seller listing creation failed');

  const ownUpdate = await request(`/api/listings/${ownCreate.body.listing.id}`, {
    method: 'PUT',
    headers: authHeader(seller.body.token),
    body: { title: 'Updated Seller Item', price: 30 }
  });
  assert(ownUpdate.status === 200, 'Seller could not update own listing');

  const otherCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(secondSeller.body.token),
    body: { title: 'Other Seller Item', description: 'Other owner', category: 'Electronics', price: 100, condition: 'Excellent', deliveryMode: 'delivery', location: 'Campus' }
  });
  assert(otherCreate.status === 201, 'Second seller listing creation failed');

  const crossUpdate = await request(`/api/listings/${otherCreate.body.listing.id}`, {
    method: 'PUT',
    headers: authHeader(seller.body.token),
    body: { title: 'Cross-owner update' }
  });
  assert(crossUpdate.status === 403, "Seller could update another user's listing");

  const crossDelete = await request(`/api/listings/${otherCreate.body.listing.id}`, {
    method: 'DELETE',
    headers: authHeader(seller.body.token)
  });
  assert(crossDelete.status === 403, "Seller could delete another user's listing");

  const publicListings = await request('/api/listings');
  assert(publicListings.status === 200, 'Public listings browse failed');
  const publicDetail = await request(`/api/listings/${ownCreate.body.listing.id}`);
  assert(publicDetail.status === 200, 'Public listing detail failed');

  const buyerBeforeUpgrade = await dbGet('SELECT id, email, password_hash, student_verified, role FROM users WHERE email = ?', ['buyer@example.com']);
  assert(buyerBeforeUpgrade, 'Buyer account was not found');

  const buyerListing = await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [buyerBeforeUpgrade.id, 'Buyer-Owned Listing', 'Preserved through upgrade', 'Other', 40, 'Good', 'pickup', 'Campus']
  );

  const upgrade = await request('/api/users/me/upgrade-to-seller', {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(upgrade.status === 200, 'Buyer upgrade failed');
  assert(upgrade.body.user.id === buyer.body.user.id, 'Upgrade changed the user ID');
  assert(upgrade.body.user.email === buyer.body.user.email, 'Upgrade changed the email');
  assert(upgrade.body.user.role === 'seller', 'Buyer upgrade did not produce Seller role');
  assert(upgrade.body.token, 'Upgrade did not return a refreshed token');
  assert(upgrade.body.user.student_verified === Boolean(buyerBeforeUpgrade.student_verified), 'Upgrade changed verification state');

  const preservedListing = await dbGet('SELECT id, user_id FROM listings WHERE id = ?', [buyerListing.lastID]);
  assert(preservedListing, 'Listing disappeared after Buyer upgrade');
  assert(preservedListing.user_id === buyerBeforeUpgrade.id, 'Listing owner changed after Buyer upgrade');

  const buyerAfterUpgrade = await dbGet('SELECT id, email, password_hash, student_verified, role FROM users WHERE id = ?', [buyerBeforeUpgrade.id]);
  assert(buyerAfterUpgrade.id === buyerBeforeUpgrade.id, 'Upgrade changed the user ID');
  assert(buyerAfterUpgrade.email === buyerBeforeUpgrade.email, 'Upgrade changed the email');
  assert(buyerAfterUpgrade.password_hash === buyerBeforeUpgrade.password_hash, 'Upgrade changed the password hash');
  assert(buyerAfterUpgrade.student_verified === buyerBeforeUpgrade.student_verified, 'Upgrade changed verification state');

  const passwordLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: buyerBeforeUpgrade.email, password: 'student123' }
  });
  assert(passwordLogin.status === 200, 'Original password stopped working after upgrade');
  assert(passwordLogin.body.user.id === buyerBeforeUpgrade.id, 'Password login returned a different account');

  const repeated = await request('/api/users/me/upgrade-to-seller', {
    method: 'POST',
    headers: authHeader(upgrade.body.token)
  });
  assert(repeated.status === 200, 'Repeated upgrade was not idempotent');
  assert(repeated.body.user.role === 'seller', 'Repeated upgrade changed account role');

  const missingToken = await request('/api/users/me/upgrade-to-seller', { method: 'POST' });
  assert(missingToken.status === 401, 'Missing upgrade token was not rejected');

  const invalidToken = await request('/api/users/me/upgrade-to-seller', {
    method: 'POST',
    headers: authHeader('invalid-token')
  });
  assert(invalidToken.status === 401, 'Invalid upgrade token was not rejected');

  const unsupportedPasswordHash = await bcrypt.hash('student123', 10);
  await dbRun(
    "INSERT INTO users (name, email, password_hash, role, student_verified) VALUES (?, ?, ?, ?, ?)",
    ['Unsupported User', 'unsupported@example.com', unsupportedPasswordHash, 'admin', 1]
  );
  const unsupportedSignup = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'unsupported@example.com', password: 'student123' }
  });
  assert(unsupportedSignup.status === 200, 'Unsupported-role account login failed');

  const unsupportedBefore = await dbGet('SELECT id, role FROM users WHERE email = ?', ['unsupported@example.com']);
  const unsupportedUpgrade = await request('/api/users/me/upgrade-to-seller', {
    method: 'POST',
    headers: authHeader(unsupportedSignup.body.token),
    body: { role: 'seller', userId: buyerBeforeUpgrade.id }
  });
  assert(unsupportedUpgrade.status === 409, 'Unsupported role was silently upgraded');

  const unsupportedAfter = await dbGet('SELECT id, role FROM users WHERE email = ?', ['unsupported@example.com']);
  assert(unsupportedAfter.role === 'admin', 'Unsupported role changed unexpectedly');

  const bodySecurityUpgrade = await request('/api/users/me/upgrade-to-seller', {
    method: 'POST',
    headers: authHeader(bodySecurityBuyer.body.token),
    body: { role: 'admin', userId: seller.body.user.id }
  });
  assert(bodySecurityUpgrade.status === 200, 'Authenticated Buyer upgrade rejected valid account state');
  assert(bodySecurityUpgrade.body.user.id === bodySecurityBuyer.body.user.id, 'Upgrade followed a request-body user ID');
  assert(bodySecurityUpgrade.body.user.role === 'seller', 'Upgrade accepted a request-body role');

  const targetSeller = await dbGet('SELECT id, role FROM users WHERE id = ?', [seller.body.user.id]);
  assert(targetSeller.role === 'seller', 'Target Seller role unexpectedly changed');

  const sellerOwnDelete = await request(`/api/listings/${ownCreate.body.listing.id}`, {
    method: 'DELETE',
    headers: authHeader(seller.body.token)
  });
  assert(sellerOwnDelete.status === 200, 'Seller could not delete own listing');

  const upgradedCannotClaimBuyerCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(upgrade.body.token),
    body: { title: 'Upgraded Buyer Listing', description: 'Now allowed', category: 'Other', price: 15, condition: 'Good', deliveryMode: 'pickup' }
  });
  assert(upgradedCannotClaimBuyerCreate.status === 201, 'Upgraded Seller could not create listings');

  await stopServer();

  await dbRun("UPDATE users SET role = 'student' WHERE email = 'demo@studentmarket.com'");
  await startServer();

  const demoLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'demo@studentmarket.com', password: 'student123' }
  });
  assert(demoLogin.status === 200, 'Legacy account could not log in after normalization');

  const demoUser = await request('/api/users/me', {
    headers: authHeader(demoLogin.body.token)
  });
  assert(demoUser.status === 200, 'Normalized legacy account /users/me failed');
  assert(demoUser.body.user.role === 'buyer', 'Legacy student role was not normalized to buyer');

  await dbRun("UPDATE users SET role = 'admin' WHERE email = 'unsupported@example.com'");
  await stopServer();
  await startServer();

  const normalizedBuyer = await dbGet("SELECT role FROM users WHERE email = 'demo@studentmarket.com'");
  assert(normalizedBuyer.role === 'buyer', 'Repeated initialization changed Buyer role');
  const normalizedSeller = await dbGet("SELECT role FROM users WHERE email = 'seller@campus.edu'");
  assert(normalizedSeller.role === 'seller', 'Repeated initialization changed Seller role');
  const unknownRole = await dbGet("SELECT role FROM users WHERE email = 'unsupported@example.com'");
  assert(unknownRole.role === 'admin', 'Repeated initialization changed unknown role');

  await stopServer();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('Phase 1 API tests passed');
}

run().catch(async (error) => {
  await stopServer();
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  console.error(error.message);
  process.exit(1);
});
