const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const TEST_JWT_SECRET = 'student-market-api-test-only-secret';
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

async function assertJwtSecretRequired(secretValue, label) {
  const probePort = await getAvailablePort();
  const probeDbPath = path.join(testDir, `jwt-secret-${label}.db`);
  const environment = {
    ...process.env,
    PORT: String(probePort),
    STUDENT_MARKET_DB_PATH: probeDbPath
  };
  if (secretValue === undefined) delete environment.JWT_SECRET;
  else environment.JWT_SECRET = secretValue;

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not reject ${label} JWT_SECRET.`));
    }, 3000);

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 1) {
        return reject(new Error(`Server did not fail with exit code 1 for ${label} JWT_SECRET.`));
      }
      if (!stderr.includes('Configuration error: JWT_SECRET must be set to a non-empty value.')) {
        return reject(new Error(`Server did not report the expected safe configuration error for ${label} JWT_SECRET.`));
      }
      if (fs.existsSync(probeDbPath)) {
        return reject(new Error(`Server opened the database before rejecting ${label} JWT_SECRET.`));
      }
      resolve();
    });
  });
}

function startServer(extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        JWT_SECRET: TEST_JWT_SECRET,
        STUDENT_MARKET_DB_PATH: dbPath,
        ...extraEnvironment
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

function fixedDateNodeOptions(fixedTime) {
  const preloadPath = path.join(testDir, 'fixed-date.cjs');
  fs.writeFileSync(preloadPath, `
    const NativeDate = globalThis.Date;
    const fixedTime = ${fixedTime};
    const FixedDate = new Proxy(NativeDate, {
      apply() {
        return new NativeDate(fixedTime).toString();
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length ? args : [fixedTime], newTarget);
      }
    });
    FixedDate.now = () => fixedTime;
    globalThis.Date = FixedDate;
  `, 'utf8');

  const inheritedOptions = process.env.NODE_OPTIONS || '';
  return `${inheritedOptions} --require="${preloadPath}"`.trim();
}

function stopServer() {
  if (!serverProcess) return Promise.resolve();
  return new Promise((resolve) => {
    serverProcess.once('exit', () => resolve());
    serverProcess.kill();
  });
}

function runSqliteAt(databasePath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath);
    db.run(sql, params, function (error) {
      db.close();
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function getSqliteAt(databasePath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath);
    db.get(sql, params, (error, row) => {
      db.close();
      if (error) reject(error);
      else resolve(row);
    });
  });
}

async function assertForeignKeyPreflightStopsWithoutRepair() {
  const orphanDbPath = path.join(testDir, 'orphaned-foreign-key.db');
  await runSqliteAt(orphanDbPath, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      student_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runSqliteAt(orphanDbPath, `
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      condition TEXT NOT NULL,
      delivery_mode TEXT DEFAULT 'pickup',
      location TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await runSqliteAt(
    orphanDbPath,
    'INSERT INTO listings (user_id, title, description, category, price, condition) VALUES (?, ?, ?, ?, ?, ?)',
    [987654, 'Orphan listing', 'Preflight fixture', 'Other', 1, 'Good']
  );

  const probePort = await getAvailablePort();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(probePort),
        JWT_SECRET: TEST_JWT_SECRET,
        STUDENT_MARKET_DB_PATH: orphanDbPath
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Server did not stop on the orphaned foreign-key fixture.'));
    }, 5000);

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 1) return reject(new Error('Server did not fail on the orphaned foreign-key fixture.'));
      if (!stderr.includes('Foreign-key integrity check failed')) {
        return reject(new Error('Foreign-key preflight failure was not reported.'));
      }
      resolve();
    });
  });

  const orphanCount = await getSqliteAt(orphanDbPath, 'SELECT COUNT(*) AS total FROM listings WHERE user_id = ?', [987654]);
  const userCount = await getSqliteAt(orphanDbPath, 'SELECT COUNT(*) AS total FROM users');
  assert(orphanCount.total === 1, 'Foreign-key preflight changed the orphaned listing');
  assert(userCount.total === 0, 'Foreign-key preflight seeded or changed users before stopping');
}

function request(requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const requestBody = options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : null;
    const headers = {
      ...(options.headers || {}),
      ...(requestBody !== null ? { 'Content-Type': 'application/json' } : {})
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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);
    if (requestBody !== null) req.write(requestBody);
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
  await assertForeignKeyPreflightStopsWithoutRepair();
  dbPath = path.join(testDir, 'test.db');
  await assertJwtSecretRequired(undefined, 'missing');
  await assertJwtSecretRequired('   ', 'blank');
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

  const buyerDashboard = await request('/api/dashboard', {
    headers: authHeader(buyer.body.token)
  });
  assert(buyerDashboard.status === 200, 'Buyer dashboard request failed');
  assert(buyerDashboard.body.activity.length === 0, 'Buyer dashboard included fabricated seller activity');

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

  const concurrentCreates = await Promise.all(['Concurrent Item A', 'Concurrent Item B'].map((title) =>
    request('/api/listings', {
      method: 'POST',
      headers: authHeader(seller.body.token),
      body: { title, description: 'Concurrent transaction test', category: 'Other', price: 12, condition: 'Good', deliveryMode: 'pickup', location: 'Campus' }
    })
  ));
  assert(concurrentCreates.every((response) => response.status === 201), 'Concurrent listing transactions did not both commit');
  assert(concurrentCreates[0].body.listing.id !== concurrentCreates[1].body.listing.id, 'Concurrent listing transactions reused a listing ID');

  const listingCountBeforeRollback = await dbGet(
    'SELECT COUNT(*) AS total FROM listings WHERE user_id = ?',
    [seller.body.user.id]
  );
  await dbRun(`
    CREATE TRIGGER reject_transaction_listing
    AFTER INSERT ON listings
    WHEN NEW.title = 'Rollback Transaction Test'
    BEGIN
      SELECT RAISE(FAIL, 'forced transaction test failure');
    END
  `);
  const rollbackResponse = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(seller.body.token),
    body: { title: 'Rollback Transaction Test', description: 'Must not persist', category: 'Other', price: 13, condition: 'Good', deliveryMode: 'pickup', location: 'Campus' }
  });
  assert(rollbackResponse.status === 500, 'Forced transaction failure did not produce an API error');
  await dbRun('DROP TRIGGER reject_transaction_listing');
  const listingCountAfterRollback = await dbGet(
    'SELECT COUNT(*) AS total FROM listings WHERE user_id = ?',
    [seller.body.user.id]
  );
  assert(listingCountAfterRollback.total === listingCountBeforeRollback.total, 'Failed listing transaction left a partial insert');

  const validListing = {
    title: 'Valid Item',
    description: 'Valid description',
    category: 'Other',
    price: 10,
    condition: 'Good',
    deliveryMode: 'pickup',
    location: 'Campus'
  };
  const invalidListingCases = [
    [{ ...validListing, title: '   ' }, 'blank title'],
    [{ ...validListing, description: '' }, 'blank description'],
    [{ ...validListing, category: 12 }, 'non-string category'],
    [{ ...validListing, title: 'x'.repeat(121) }, 'oversized title'],
    [{ ...validListing, description: 'x'.repeat(2001) }, 'oversized description'],
    [{ ...validListing, category: 'x'.repeat(61) }, 'oversized category'],
    [{ ...validListing, price: 0 }, 'zero price'],
    [{ ...validListing, price: -1 }, 'negative price'],
    [{ ...validListing, price: '10' }, 'string price'],
    [{ ...validListing, price: Number.NaN }, 'non-finite price'],
    [{ ...validListing, condition: 'Like New' }, 'unsupported condition'],
    [{ ...validListing, deliveryMode: 'ship' }, 'unsupported delivery mode'],
    [{ ...validListing, location: null }, 'null location'],
    [{ ...validListing, location: '' }, 'blank location'],
    [{ ...validListing, location: '   ' }, 'whitespace location'],
    [{ ...validListing, location: undefined }, 'missing location'],
    [{ ...validListing, location: 'x'.repeat(121) }, 'oversized location']
  ];

  for (const [body, label] of invalidListingCases) {
    const invalidCreate = await request('/api/listings', {
      method: 'POST',
      headers: authHeader(seller.body.token),
      body
    });
    assert(invalidCreate.status === 400, `Listing creation accepted ${label}`);
  }

  const listingCountBeforeNonFiniteCreate = await dbGet(
    'SELECT COUNT(*) AS total FROM listings WHERE user_id = ?',
    [seller.body.user.id]
  );
  const nonFiniteCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(seller.body.token),
    rawBody: '{"title":"Non-finite price","description":"Invalid JSON number","category":"Other","price":1e400,"condition":"Good","deliveryMode":"pickup","location":"Campus"}'
  });
  assert(nonFiniteCreate.status === 400, 'Listing creation accepted a non-finite JSON price');
  const listingCountAfterNonFiniteCreate = await dbGet(
    'SELECT COUNT(*) AS total FROM listings WHERE user_id = ?',
    [seller.body.user.id]
  );
  assert(listingCountAfterNonFiniteCreate.total === listingCountBeforeNonFiniteCreate.total, 'Non-finite price created a listing');

  for (const requiredField of ['title', 'description', 'category', 'price', 'condition']) {
    const body = { ...validListing };
    delete body[requiredField];
    const missingCreateField = await request('/api/listings', {
      method: 'POST',
      headers: authHeader(seller.body.token),
      body
    });
    assert(missingCreateField.status === 400, `Listing creation accepted missing ${requiredField}`);
  }

  const ownUpdate = await request(`/api/listings/${ownCreate.body.listing.id}`, {
    method: 'PUT',
    headers: authHeader(seller.body.token),
    body: { title: 'Updated Seller Item', price: 30 }
  });
  assert(ownUpdate.status === 200, 'Seller could not update own listing');

  const listingAfterPartialUpdate = await request(`/api/listings/${ownCreate.body.listing.id}`);
  assert(listingAfterPartialUpdate.body.listing.location === 'Campus', 'Omitted location was erased by a partial update');

  const invalidUpdateCases = [
    [{ price: -3 }, 'negative price'],
    [{ price: Number.POSITIVE_INFINITY }, 'non-finite price'],
    [{ title: '   ' }, 'blank title'],
    [{ condition: 'Unknown' }, 'unsupported condition'],
    [{ deliveryMode: 'courier' }, 'unsupported delivery mode'],
    [{ location: null }, 'null location'],
    [{ location: '' }, 'blank location'],
    [{ location: '   ' }, 'whitespace location'],
    [{ status: 'removed' }, 'unsupported status'],
    [{ description: 'x'.repeat(2001) }, 'oversized description']
  ];

  for (const [body, label] of invalidUpdateCases) {
    const invalidUpdate = await request(`/api/listings/${ownCreate.body.listing.id}`, {
      method: 'PUT',
      headers: authHeader(seller.body.token),
      body
    });
    assert(invalidUpdate.status === 400, `Listing update accepted ${label}`);
  }

  const unchangedListing = await request(`/api/listings/${ownCreate.body.listing.id}`);
  assert(unchangedListing.body.listing.title === 'Updated Seller Item', 'Invalid update partially changed the listing');
  assert(unchangedListing.body.listing.price === 30, 'Invalid update partially changed the listing price');
  assert(unchangedListing.body.listing.location === 'Campus', 'Invalid update changed the listing location');

  const nonFiniteUpdate = await request(`/api/listings/${ownCreate.body.listing.id}`, {
    method: 'PUT',
    headers: authHeader(seller.body.token),
    rawBody: '{"price":1e400}'
  });
  assert(nonFiniteUpdate.status === 400, 'Listing update accepted a non-finite JSON price');
  const listingAfterNonFiniteUpdate = await request(`/api/listings/${ownCreate.body.listing.id}`);
  assert(listingAfterNonFiniteUpdate.body.listing.price === 30, 'Non-finite price modified the listing');

  const otherCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(secondSeller.body.token),
    body: { title: 'Other Seller Item', description: 'Other owner', category: 'Electronics', price: 100, condition: 'Excellent', deliveryMode: 'delivery', location: 'Campus' }
  });
  assert(otherCreate.status === 201, 'Second seller listing creation failed');

  const sellerDashboard = await request('/api/dashboard', {
    headers: authHeader(seller.body.token)
  });
  assert(sellerDashboard.status === 200, 'Seller dashboard request failed');
  assert(sellerDashboard.body.listings.every((item) => item.user_id === seller.body.user.id), 'Dashboard returned another seller\'s listing');
  assert(sellerDashboard.body.stats.totalListings === sellerDashboard.body.listings.length, 'Dashboard total listing count is not based on returned listings');
  assert(sellerDashboard.body.stats.activeListings === sellerDashboard.body.listings.filter((item) => item.status === 'active').length, 'Dashboard active count is not based on listing state');
  assert(sellerDashboard.body.activity[0].text.includes(sellerDashboard.body.listings[0].title), 'Seller activity is not based on an actual listing');
  assert(!Object.prototype.hasOwnProperty.call(sellerDashboard.body.stats, 'totalSales'), 'Dashboard still returns fabricated sales');
  assert(!Object.prototype.hasOwnProperty.call(sellerDashboard.body.stats, 'ordersPlaced'), 'Dashboard still returns fabricated orders');
  assert(!Object.prototype.hasOwnProperty.call(sellerDashboard.body.stats, 'walletBalance'), 'Dashboard still returns fabricated wallet balance');

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

  await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [seller.body.user.id, 'Calculus Workbook', 'Practice equations and worked solutions', 'Textbooks', 20, 'Good', 'pickup', 'Campus', 'active', '2026-01-02 10:00:00']
  );
  await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [secondSeller.body.user.id, 'Portable Study Laptop', 'A portable computer for campus work', 'Electronics', 20, 'Excellent', 'delivery', 'Library', 'active', '2026-01-02 10:00:00']
  );
  await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [secondSeller.body.user.id, 'Campus Electronics Kit', 'A campus electronics kit for student study', 'Electronics', 10, 'Good', 'pickup', 'Campus', 'active', '2026-01-02 10:00:00']
  );
  await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [secondSeller.body.user.id, 'Sold Study Desk', 'A desk that has already been sold', 'Furniture', 500, 'Fair', 'pickup', 'Campus', 'sold', '2026-01-01 10:00:00']
  );

  const publicListings = await request('/api/listings');
  assert(publicListings.status === 200, 'Public listings browse failed');
  assert(publicListings.body.listings.every((item) => item.status === 'active'), 'Public browse returned a sold listing');

  const titleSearch = await request('/api/listings?q=calculus');
  assert(titleSearch.status === 200, 'Title search failed');
  assert(titleSearch.body.listings.some((item) => item.title === 'Calculus Workbook'), 'Title search did not match the title');

  const descriptionSearch = await request('/api/listings?q=PORTABLE');
  assert(descriptionSearch.status === 200, 'Description search failed');
  assert(descriptionSearch.body.listings.some((item) => item.description.includes('portable')), 'Case-insensitive description search did not match');

  const categorySearch = await request('/api/listings?q=ELECTRONICS');
  assert(categorySearch.status === 200, 'Category search failed');
  assert(categorySearch.body.listings.some((item) => item.category === 'Electronics'), 'Search did not match category text');

  const exactCategory = await request('/api/listings?category=Textbooks');
  assert(exactCategory.status === 200, 'Category filtering failed');
  assert(exactCategory.body.listings.every((item) => item.category.toLowerCase() === 'textbooks'), 'Category filter returned a different category');
  const caseInsensitiveCategory = await request('/api/listings?category=textbooks');
  assert(caseInsensitiveCategory.status === 200, 'Case-insensitive category filtering failed');
  assert(caseInsensitiveCategory.body.listings.every((item) => item.category.toLowerCase() === 'textbooks'), 'Case-insensitive category filter returned a different category');

  const combinedFilter = await request('/api/listings?q=campus&category=Electronics');
  assert(combinedFilter.status === 200, 'Combined search and category filtering failed');
  assert(combinedFilter.body.listings.every((item) => item.category === 'Electronics'), 'Combined filter ignored category');
  assert(combinedFilter.body.listings.some((item) => item.title === 'Portable Study Laptop'), 'Combined filter did not match search and category together');

  const combinedSortFilter = await request('/api/listings?q=campus&category=Electronics&sort=lowest');
  assert(combinedSortFilter.status === 200, 'Combined search, category, and sorting failed');
  assert(combinedSortFilter.body.listings.every((item) => item.category === 'Electronics'), 'Combined sorting filter ignored category');
  assert(combinedSortFilter.body.listings.some((item) => item.title === 'Campus Electronics Kit'), 'Combined sorting filter ignored search');
  assert(combinedSortFilter.body.listings.every((item, index, items) =>
    index === 0 || items[index - 1].price <= item.price
  ), 'Combined sorting filter did not apply lowest-price sorting');

  const lowestSort = await request('/api/listings?sort=lowest');
  assert(lowestSort.status === 200, 'Lowest-price sort failed');
  assert(lowestSort.body.listings.every((item, index, items) =>
    index === 0 || items[index - 1].price <= item.price
  ), 'Lowest-price sort was not ascending');
  const lowestTieItems = lowestSort.body.listings.filter((item) => item.price === 20);
  assert(lowestTieItems.length >= 2 &&
    lowestTieItems[0].id < lowestTieItems[1].id, 'Equal-price results were not deterministic');

  const highestSort = await request('/api/listings?sort=highest');
  assert(highestSort.status === 200, 'Highest-price sort failed');
  assert(highestSort.body.listings.every((item, index, items) =>
    index === 0 || items[index - 1].price >= item.price
  ), 'Highest-price sort was not descending');
  const highestTieItems = highestSort.body.listings.filter((item) => item.price === 20);
  assert(highestTieItems.length >= 2 &&
    highestTieItems[0].id > highestTieItems[1].id, 'Equal-price highest-price results were not deterministic');

  const newestSort = await request('/api/listings?sort=newest');
  assert(newestSort.status === 200, 'Newest sort failed');
  assert(newestSort.body.listings.every((item, index, items) =>
    index === 0 || items[index - 1].created_at >= item.created_at
  ), 'Newest sort was not descending');
  const newestTieItems = newestSort.body.listings.filter((item) => item.created_at === '2026-01-02 10:00:00');
  assert(newestTieItems.length >= 2 &&
    newestTieItems[0].id > newestTieItems[1].id, 'Equal-date results were not deterministic');

  for (const invalidSortValue of ['price_random', 'lowest-price', 'highest-price', 'price-asc', 'price-desc']) {
    const invalidSort = await request(`/api/listings?sort=${encodeURIComponent(invalidSortValue)}`);
    assert(invalidSort.status === 400, `Invalid sort '${invalidSortValue}' did not return HTTP 400`);
  }

  const expectedPublicKeys = [
    'category',
    'condition',
    'created_at',
    'delivery_mode',
    'description',
    'id',
    'location',
    'price',
    'seller_id',
    'seller_name',
    'status',
    'title'
  ];
  assert(publicListings.body.listings.every((item) =>
    JSON.stringify(Object.keys(item).sort()) === JSON.stringify(expectedPublicKeys)
  ), 'Public listings did not return the exact public DTO key set');
  assert(publicListings.body.listings.every((item) =>
    !Object.prototype.hasOwnProperty.call(item, 'user_id') &&
    !Object.prototype.hasOwnProperty.call(item, 'email') &&
    !Object.prototype.hasOwnProperty.call(item, 'password_hash')
  ), 'Public listings exposed an internal or private field');

  const publicDetail = await request(`/api/listings/${ownCreate.body.listing.id}`);
  assert(publicDetail.status === 200, 'Public listing detail failed');
  assert(JSON.stringify(Object.keys(publicDetail.body.listing).sort()) === JSON.stringify(expectedPublicKeys),
    'Public listing detail did not return the exact public DTO key set');

  const soldDetail = await request('/api/listings/' + await dbGet('SELECT id FROM listings WHERE status = ?', ['sold']).then((row) => row.id));
  assert(soldDetail.status === 200, 'Sold listing detail was not accessible');
  assert(soldDetail.body.listing.status === 'sold', 'Sold listing detail did not return sold status');

  const missingDetail = await request('/api/listings/999999999');
  assert(missingDetail.status === 404, 'Missing listing detail did not return HTTP 404');

  const emptySeller = await signup('Empty Seller', 'empty-seller@campus.edu', 'seller');
  assert(emptySeller.status === 201, 'Empty Seller signup failed');

  const sellerProfile = await request(`/api/sellers/${secondSeller.body.user.id}`);
  assert(sellerProfile.status === 200, 'Existing Seller profile failed');
  assert(JSON.stringify(Object.keys(sellerProfile.body.seller).sort()) ===
    JSON.stringify(['id', 'name']), 'Seller profile returned fields outside the public seller DTO');
  assert(sellerProfile.body.seller.id === secondSeller.body.user.id, 'Seller profile returned the wrong Seller');
  assert(sellerProfile.body.seller.name === secondSeller.body.user.name, 'Seller profile returned the wrong display name');
  assert(JSON.stringify(Object.keys(sellerProfile.body).sort()) ===
    JSON.stringify(['listings', 'seller']), 'Seller profile returned unexpected top-level fields');

  assert(sellerProfile.body.listings.every((item) => item.seller_id === secondSeller.body.user.id),
    'Seller profile included a listing owned by another Seller');
  assert(sellerProfile.body.listings.every((item) => item.status === 'active'),
    'Seller profile included a sold listing');
  assert(!sellerProfile.body.listings.some((item) => item.title === 'Sold Study Desk'),
    'Seller profile included the sold desk fixture');

  const profileTieItems = sellerProfile.body.listings.filter((item) =>
    item.created_at === '2026-01-02 10:00:00'
  );
  assert(profileTieItems.length >= 2 &&
    profileTieItems[0].id > profileTieItems[1].id,
    'Seller profile newest-first tie-breaking was not deterministic');
  assert(sellerProfile.body.listings.every((item, index, items) =>
    index === 0 || (
      items[index - 1].created_at > item.created_at ||
      (items[index - 1].created_at === item.created_at && items[index - 1].id > item.id)
    )
  ), 'Seller profile listings were not ordered newest first');

  assert(sellerProfile.body.listings.every((item) =>
    JSON.stringify(Object.keys(item).sort()) === JSON.stringify([
      'category',
      'condition',
      'created_at',
      'delivery_mode',
      'description',
      'id',
      'location',
      'price',
      'seller_id',
      'seller_name',
      'status',
      'title'
    ])
  ), 'Seller profile listing DTO did not return the exact public key set');
  assert(sellerProfile.body.listings.every((item) =>
    !Object.prototype.hasOwnProperty.call(item, 'email') &&
    !Object.prototype.hasOwnProperty.call(item, 'password_hash') &&
    !Object.prototype.hasOwnProperty.call(item, 'role') &&
    !Object.prototype.hasOwnProperty.call(item, 'student_verified')
  ), 'Seller profile listing exposed private account fields');

  const emptySellerProfile = await request(`/api/sellers/${emptySeller.body.user.id}`);
  assert(emptySellerProfile.status === 200, 'Seller with no active listings did not return HTTP 200');
  assert(Array.isArray(emptySellerProfile.body.listings) && emptySellerProfile.body.listings.length === 0,
    'Seller with no active listings did not return an empty array');

  const missingSellerProfile = await request('/api/sellers/999999999');
  assert(missingSellerProfile.status === 404, 'Missing numeric Seller ID did not return HTTP 404');

  const buyerSellerProfile = await request(`/api/sellers/${buyer.body.user.id}`);
  assert(buyerSellerProfile.status === 404, 'Buyer account was exposed as a Seller profile');

  for (const invalidSellerId of ['abc', '0', '-1', '1.5', '9007199254740992', '']) {
    const invalidSellerProfile = await request(
      invalidSellerId ? `/api/sellers/${encodeURIComponent(invalidSellerId)}` : '/api/sellers/'
    );
    assert(invalidSellerProfile.status === (invalidSellerId ? 400 : 404),
      `Seller ID '${invalidSellerId}' returned the wrong status`);
  }

  const publicBrowseSellerId = publicListings.body.listings.every((item) =>
    Number.isSafeInteger(item.seller_id) && item.seller_id > 0
  );
  assert(publicBrowseSellerId, 'Public browse listings omitted a valid seller_id');
  assert(Number.isSafeInteger(publicDetail.body.listing.seller_id) &&
    publicDetail.body.listing.seller_id > 0,
    'Public detail listing omitted a valid seller_id');

  const unauthConversation = await request(`/api/listings/${otherCreate.body.listing.id}/conversations`, {
    method: 'POST'
  });
  assert(unauthConversation.status === 401, 'Unauthenticated conversation creation was not rejected');

  const sellerConversationCreate = await request(`/api/listings/${otherCreate.body.listing.id}/conversations`, {
    method: 'POST',
    headers: authHeader(seller.body.token)
  });
  assert(sellerConversationCreate.status === 403, 'Seller could create an enquiry as a Buyer');

  const buyerOwnedListing = await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [buyer.body.user.id, 'Buyer-Owned Inquiry Fixture', 'Own listing fixture', 'Other', 15, 'Good', 'pickup', 'Campus']
  );
  const ownConversation = await request(`/api/listings/${buyerOwnedListing.lastID}/conversations`, {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(ownConversation.status === 409, 'Buyer could enquire about an own listing');

  const soldConversationListing = await dbGet(
    'SELECT id FROM listings WHERE status = ? LIMIT 1',
    ['sold']
  );
  const soldConversation = await request(`/api/listings/${soldConversationListing.id}/conversations`, {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(soldConversation.status === 409, 'Buyer could enquire about a sold listing');

  const firstConversationResponse = await request(`/api/listings/${otherCreate.body.listing.id}/conversations`, {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(firstConversationResponse.status === 201, 'Buyer conversation creation failed');
  assert(firstConversationResponse.body.created === true, 'New conversation did not report created=true');
  assert(firstConversationResponse.body.conversation.listing_id === otherCreate.body.listing.id,
    'Conversation was linked to the wrong listing');

  const duplicateConversationResponse = await request(`/api/listings/${otherCreate.body.listing.id}/conversations`, {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(duplicateConversationResponse.status === 200, 'Duplicate conversation did not return HTTP 200');
  assert(duplicateConversationResponse.body.created === false, 'Duplicate conversation created a duplicate');
  assert(duplicateConversationResponse.body.conversation.id === firstConversationResponse.body.conversation.id,
    'Duplicate conversation returned a different conversation');
  const duplicateMessageCount = await dbGet(
    'SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?',
    [firstConversationResponse.body.conversation.id]
  );
  assert(duplicateMessageCount.total === 0,
    'Duplicate conversation creation created or appended a message');

  const concurrentConversationResponses = await Promise.all(
    [buyer.body.token, buyer.body.token].map(() =>
      request(`/api/listings/${ownCreate.body.listing.id}/conversations`, {
        method: 'POST',
        headers: authHeader(buyer.body.token)
      })
    )
  );
  assert(concurrentConversationResponses.every((response) => response.status === 201 || response.status === 200),
    'Concurrent duplicate conversation creation failed');
  assert(concurrentConversationResponses.every((response) =>
    response.body.conversation.id === concurrentConversationResponses[0].body.conversation.id
  ), 'Concurrent conversation creation produced different conversations');

  const concurrentConversationId = concurrentConversationResponses[0].body.conversation.id;
  const concurrentConversationCount = await dbGet(
    'SELECT COUNT(*) AS total FROM conversations WHERE listing_id = ? AND buyer_id = ?',
    [ownCreate.body.listing.id, buyer.body.user.id]
  );
  assert(concurrentConversationCount.total === 1, 'Concurrent conversation creation left duplicates');
  const concurrentMessageCount = await dbGet(
    'SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?',
    [concurrentConversationId]
  );
  assert(concurrentMessageCount.total === 0,
    'Concurrent conversation creation created a message');

  const conversationId = firstConversationResponse.body.conversation.id;
  const conversationDetail = await request(`/api/conversations/${conversationId}`, {
    headers: authHeader(buyer.body.token)
  });
  assert(conversationDetail.status === 200, 'Buyer could not read own conversation');
  assert(conversationDetail.body.conversation.other_participant.id === secondSeller.body.user.id,
    'Conversation returned the wrong participant');

  const sellerConversationDetail = await request(`/api/conversations/${conversationId}`, {
    headers: authHeader(secondSeller.body.token)
  });
  assert(sellerConversationDetail.status === 200, 'Listing Seller could not read own conversation');

  const nonParticipantConversation = await request(`/api/conversations/${conversationId}`, {
    headers: authHeader(bodySecurityBuyer.body.token)
  });
  assert(nonParticipantConversation.status === 404, 'Nonparticipant could read a conversation');

  const nonParticipantMessages = await request(`/api/conversations/${conversationId}/messages`, {
    headers: authHeader(bodySecurityBuyer.body.token)
  });
  assert(nonParticipantMessages.status === 404, 'Nonparticipant could read conversation messages');

  const blankMessage = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: '   ', senderId: secondSeller.body.user.id, sellerId: secondSeller.body.user.id }
  });
  assert(blankMessage.status === 400, 'Whitespace-only message was accepted');

  const oversizedMessage = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'x'.repeat(2001) }
  });
  assert(oversizedMessage.status === 400, 'Over-limit message was accepted');

  const boundaryMessage = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: {
      content: 'x'.repeat(2000),
      senderId: secondSeller.body.user.id,
      recipientId: secondSeller.body.user.id,
      listingId: ownCreate.body.listing.id
    }
  });
  assert(boundaryMessage.status === 201, 'Exactly 2000-character message was rejected');
  assert(boundaryMessage.body.message.sender.id === buyer.body.user.id,
    'Message sender identity was taken from the request body');
  assert(JSON.stringify(Object.keys(boundaryMessage.body.message).sort()) ===
    JSON.stringify(['content', 'created_at', 'id', 'sender']),
    'Send-message response returned fields outside the public message DTO');

  const sellerReply = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(secondSeller.body.token),
    body: { content: 'Seller reply', senderId: buyer.body.user.id, buyerId: buyer.body.user.id }
  });
  assert(sellerReply.status === 201, 'Listing Seller could not reply');
  assert(sellerReply.body.message.sender.id === secondSeller.body.user.id,
    'Seller reply sender identity was incorrect');

  const nonOwnerSellerReply = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(seller.body.token),
    body: { content: 'Unauthorized reply' }
  });
  assert(nonOwnerSellerReply.status === 404, 'Non-owner Seller could reply to a conversation');

  const unrelatedBuyerSend = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(bodySecurityBuyer.body.token),
    body: { content: 'Unrelated Buyer attempt' }
  });
  assert(unrelatedBuyerSend.status === 404, 'Unrelated Buyer could send to another conversation');

  const initialMessagePage = await request(
    `/api/conversations/${conversationId}/messages?limit=30`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(initialMessagePage.status === 200, 'Message history request failed');
  assert(initialMessagePage.body.messages.length === 2, 'Message history did not return the inserted messages');
  assert(initialMessagePage.body.messages[0].sender.id === buyer.body.user.id,
    'Message history was not oldest-first');
  assert(initialMessagePage.body.messages.every((item) =>
    JSON.stringify(Object.keys(item).sort()) ===
    JSON.stringify(['content', 'created_at', 'id', 'sender'])
  ), 'Message-history response returned fields outside the public message DTO');

  const firstHistoryPage = await request(
    `/api/conversations/${conversationId}/messages?limit=1`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(firstHistoryPage.status === 200, 'First paginated message page failed');
  assert(firstHistoryPage.body.messages.length === 1, 'Message history limit was not applied');
  assert(firstHistoryPage.body.nextCursor, 'Message history did not provide a compound cursor');

  const olderHistoryPage = await request(
    `/api/conversations/${conversationId}/messages?limit=1&beforeCreatedAt=${encodeURIComponent(firstHistoryPage.body.nextCursor.beforeCreatedAt)}&beforeId=${firstHistoryPage.body.nextCursor.beforeId}`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(olderHistoryPage.status === 200, 'Older message page failed');

  await dbRun('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
  const tiedTimestamp = '2026-06-01T12:00:00.000Z';
  const tiedMessageIds = [];
  for (let index = 1; index <= 4; index += 1) {
    const created = await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Tied message ${index}`, tiedTimestamp]
    );
    tiedMessageIds.push(created.lastID);
  }

  const tiedPageOne = await request(
    `/api/conversations/${conversationId}/messages?limit=2`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(tiedPageOne.status === 200, 'Tied-timestamp first message page failed');
  assert(tiedPageOne.body.nextCursor, 'Tied-timestamp first message page lacked a cursor');

  const tiedPageTwo = await request(
    `/api/conversations/${conversationId}/messages?limit=2&beforeCreatedAt=${encodeURIComponent(tiedPageOne.body.nextCursor.beforeCreatedAt)}&beforeId=${tiedPageOne.body.nextCursor.beforeId}`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(tiedPageTwo.status === 200, 'Tied-timestamp second message page failed');

  const expectedLatestMessagePage = tiedMessageIds.slice(2);
  const expectedOlderMessagePage = tiedMessageIds.slice(0, 2);
  assert(JSON.stringify(tiedPageOne.body.messages.map((item) => item.id)) ===
    JSON.stringify(expectedLatestMessagePage),
    'Tied-timestamp latest message page had incorrect ID ordering');
  assert(JSON.stringify(tiedPageTwo.body.messages.map((item) => item.id)) ===
    JSON.stringify(expectedOlderMessagePage),
    'Tied-timestamp older message page had incorrect ID ordering');
  assert(JSON.stringify([
    ...tiedPageTwo.body.messages.map((item) => item.id),
    ...tiedPageOne.body.messages.map((item) => item.id)
  ]) === JSON.stringify(tiedMessageIds),
  'Tied-timestamp messages were not in exact oldest-first order across pages');
  assert(tiedPageTwo.body.nextCursor === null,
    'Tied-timestamp message pagination returned an unexpected extra page');

  for (const incompleteCursor of [
    '?limit=abc',
    '?limit=101',
    '?beforeCreatedAt=2026-01-01T00:00:00.000Z',
    '?beforeId=1',
    '?beforeCreatedAt=bad&beforeId=1',
    '?beforeCreatedAt=2026-01-01T00:00:00.000Z&beforeId=abc'
  ]) {
    const invalidCursor = await request(
      `/api/conversations/${conversationId}/messages${incompleteCursor}`,
      { headers: authHeader(buyer.body.token) }
    );
    assert(invalidCursor.status === 400, `Message cursor '${incompleteCursor}' was accepted`);
  }

  const conversationList = await request('/api/conversations?limit=20', {
    headers: authHeader(buyer.body.token)
  });
  assert(conversationList.status === 200, 'Buyer conversation list failed');
  assert(conversationList.body.conversations.every((item) =>
    item.other_participant && item.other_participant.id && item.other_participant.name
  ), 'Conversation list omitted participant metadata');

  const tiedUpdatedAt = '2099-06-01T12:00:00.000Z';
  const tiedConversationIds = [];
  for (let index = 1; index <= 4; index += 1) {
    const created = await dbRun(
      `INSERT INTO conversations
       (listing_id, listing_title_snapshot, buyer_id, seller_id, read_only, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [null, `Tied Conversation ${index}`, buyer.body.user.id, secondSeller.body.user.id, tiedUpdatedAt, tiedUpdatedAt]
    );
    tiedConversationIds.push(created.lastID);
  }

  const tiedConversationPageOne = await request(
    '/api/conversations?limit=2&beforeUpdatedAt=',
    { headers: authHeader(buyer.body.token) }
  );
  assert(tiedConversationPageOne.status === 400,
    'Empty conversation-list cursor timestamp was accepted');

  for (const invalidConversationCursor of [
    '?beforeUpdatedAt=2026-06-01T12:00:00.000Z',
    '?beforeId=1',
    '?beforeUpdatedAt=bad&beforeId=1',
    '?beforeUpdatedAt=2026-06-01T12:00:00.000Z&beforeId=abc',
    '?limit=0'
  ]) {
    const invalidConversationCursorResponse = await request(
      `/api/conversations${invalidConversationCursor}`,
      { headers: authHeader(buyer.body.token) }
    );
    assert(invalidConversationCursorResponse.status === 400,
      `Conversation cursor '${invalidConversationCursor}' was accepted`);
  }

  const tiedConversationPageOneValid = await request(
    '/api/conversations?limit=2',
    { headers: authHeader(buyer.body.token) }
  );
  assert(tiedConversationPageOneValid.status === 200, 'Tied conversation first page failed');
  assert(tiedConversationPageOneValid.body.nextCursor,
    'Tied conversation first page lacked a compound cursor');
  const tiedConversationPageTwo = await request(
    `/api/conversations?limit=2&beforeUpdatedAt=${encodeURIComponent(tiedConversationPageOneValid.body.nextCursor.beforeUpdatedAt)}&beforeId=${tiedConversationPageOneValid.body.nextCursor.beforeId}`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(tiedConversationPageTwo.status === 200, 'Tied conversation second page failed');
  const expectedLatestConversationPage = [...tiedConversationIds].reverse().slice(0, 2);
  const expectedOlderConversationPage = [...tiedConversationIds].reverse().slice(2);
  assert(JSON.stringify(tiedConversationPageOneValid.body.conversations.map((item) => item.id)) ===
    JSON.stringify(expectedLatestConversationPage),
    'Tied-timestamp latest conversation page had incorrect ID ordering');
  assert(JSON.stringify(tiedConversationPageTwo.body.conversations.map((item) => item.id)) ===
    JSON.stringify(expectedOlderConversationPage),
    'Tied-timestamp older conversation page had incorrect ID ordering');
  assert(JSON.stringify([
    ...tiedConversationPageOneValid.body.conversations.map((item) => item.id),
    ...tiedConversationPageTwo.body.conversations.map((item) => item.id)
  ]) === JSON.stringify([...tiedConversationIds].reverse()),
  'Tied-timestamp conversations were not in exact newest-first order across pages');

  const invalidConversationLimit = await request('/api/conversations?limit=101', {
    headers: authHeader(buyer.body.token)
  });
  assert(invalidConversationLimit.status === 400, 'Conversation list accepted limit above 100');

  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);
  let rateConversationId = conversationId;
  for (let index = 0; index < 3; index += 1) {
    const sent = await request(`/api/conversations/${rateConversationId}/messages`, {
      method: 'POST',
      headers: authHeader(buyer.body.token),
      body: { content: `Minute message ${index}` }
    });
    assert(sent.status === 201, `Message ${index + 1} in minute-rate fixture was rejected`);
  }

  const crossConversation = await request(`/api/listings/${ownCreate.body.listing.id}/conversations`, {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(crossConversation.status === 200 || crossConversation.status === 201,
    'Cross-conversation rate fixture failed');
  rateConversationId = crossConversation.body.conversation.id;
  for (let index = 0; index < 2; index += 1) {
    const sent = await request(`/api/conversations/${rateConversationId}/messages`, {
      method: 'POST',
      headers: authHeader(buyer.body.token),
      body: { content: `Cross-conversation minute message ${index}` }
    });
    assert(sent.status === 201, `Cross-conversation message ${index + 1} was rejected`);
  }

  const rateLimited = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Must be rate limited' }
  });
  assert(rateLimited.status === 429, 'Per-user minute rate limit was not enforced');
  assert(rateLimited.body.retryAfterSeconds >= 1, 'Rate-limit response omitted retryAfterSeconds');
  assert(Number(rateLimited.headers['retry-after']) >= 1, 'Rate-limit response omitted Retry-After');

  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);
  const hourFixtureTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  for (let index = 0; index < 30; index += 1) {
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Hour fixture ${index}`, hourFixtureTimestamp]
    );
  }
  const hourLimited = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Must be hour rate limited' }
  });
  assert(hourLimited.status === 429, 'Per-user hourly rate limit was not enforced');
  assert(hourLimited.body.retryAfterSeconds >= 1, 'Hourly rate-limit response omitted retryAfterSeconds');
  assert(Number(hourLimited.headers['retry-after']) >= 1, 'Hourly rate-limit response omitted Retry-After');
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  await stopServer();
  const boundaryNow = Date.now();
  await startServer({ NODE_OPTIONS: fixedDateNodeOptions(boundaryNow) });

  await dbRun(
    'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
    [conversationId, buyer.body.user.id, 'Exactly 60 seconds old', new Date(boundaryNow - 60 * 1000).toISOString()]
  );
  for (let index = 0; index < 4; index += 1) {
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Minute boundary fixture ${index}`, new Date(boundaryNow - 59999).toISOString()]
    );
  }
  const exactMinuteBoundary = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Must exclude exactly 60 seconds old' }
  });
  assert(exactMinuteBoundary.status === 201,
    'Message exactly 60 seconds old was counted in the minute window');
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  for (let index = 0; index < 5; index += 1) {
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Just-inside minute fixture ${index}`, new Date(boundaryNow - 59999).toISOString()]
    );
  }
  const justInsideMinuteBoundary = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Must count messages just inside the minute window' }
  });
  assert(justInsideMinuteBoundary.status === 429,
    'Messages just inside the minute window were not counted');
  assert(justInsideMinuteBoundary.body.retryAfterSeconds >= 1 &&
    Number(justInsideMinuteBoundary.headers['retry-after']) >= 1,
  'Minute boundary rate limit omitted valid retry information');
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  await dbRun(
    'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
    [conversationId, buyer.body.user.id, 'Exactly 3600 seconds old', new Date(boundaryNow - 3600 * 1000).toISOString()]
  );
  for (let index = 0; index < 29; index += 1) {
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Hour boundary fixture ${index}`, new Date(boundaryNow - 30 * 60 * 1000).toISOString()]
    );
  }
  const exactHourBoundary = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Must exclude exactly 3600 seconds old' }
  });
  assert(exactHourBoundary.status === 201,
    'Message exactly 3600 seconds old was counted in the hour window');
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  for (let index = 0; index < 30; index += 1) {
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Just-inside hour fixture ${index}`, new Date(boundaryNow - 3600 * 1000 + 1).toISOString()]
    );
  }
  const justInsideHourBoundary = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Must count messages just inside the hour window' }
  });
  assert(justInsideHourBoundary.status === 429,
    'Messages just inside the hour window were not counted');
  assert(justInsideHourBoundary.body.retryAfterSeconds >= 1 &&
    Number(justInsideHourBoundary.headers['retry-after']) >= 1,
  'Hour boundary rate limit omitted valid retry information');
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  for (let index = 0; index < 4; index += 1) {
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
      [conversationId, buyer.body.user.id, `Concurrent minute fixture ${index}`, new Date(boundaryNow - 1000).toISOString()]
    );
  }
  const concurrentRateResponses = await Promise.all(
    [conversationId, rateConversationId, conversationId].map((targetConversationId, index) =>
      request(`/api/conversations/${targetConversationId}/messages`, {
        method: 'POST',
        headers: authHeader(buyer.body.token),
        body: { content: `Concurrent rate-limit request ${index}` }
      })
    )
  );
  assert(concurrentRateResponses.filter((response) => response.status === 201).length === 1,
    'Concurrent sends did not permit exactly one request at the minute threshold');
  assert(concurrentRateResponses.filter((response) => response.status === 429).length === 2,
    'Concurrent sends bypassed the per-user minute limit');
  assert(concurrentRateResponses.filter((response) => response.status === 429).every((response) =>
    response.body.retryAfterSeconds >= 1 && Number(response.headers['retry-after']) >= 1
  ), 'Concurrent rate-limit responses omitted valid retry information');
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  await stopServer();
  await startServer();

  await dbRun(`
    CREATE TRIGGER reject_transaction_message
    BEFORE INSERT ON messages
    WHEN NEW.content = 'Rollback Message Test'
    BEGIN
      SELECT RAISE(FAIL, 'forced message transaction test failure');
    END
  `);
  const rollbackMessage = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(buyer.body.token),
    body: { content: 'Rollback Message Test' }
  });
  assert(rollbackMessage.status === 500, 'Forced message transaction failure did not produce an API error');
  await dbRun('DROP TRIGGER reject_transaction_message');
  const rollbackMessageCount = await dbGet(
    'SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND content = ?',
    [conversationId, 'Rollback Message Test']
  );
  assert(rollbackMessageCount.total === 0, 'Failed message transaction left a partial insert');

  const soldLaterListing = await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [secondSeller.body.user.id, 'Existing Sold Conversation', 'Becomes sold', 'Other', 25, 'Good', 'pickup', 'Campus', 'active']
  );
  const soldLaterConversation = await request(`/api/listings/${soldLaterListing.lastID}/conversations`, {
    method: 'POST',
    headers: authHeader(buyer.body.token)
  });
  assert(soldLaterConversation.status === 201, 'Could not create pre-sale conversation');
  await dbRun('UPDATE listings SET status = ? WHERE id = ?', ['sold', soldLaterListing.lastID]);
  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);

  const buyerSoldFollowUp = await request(
    `/api/conversations/${soldLaterConversation.body.conversation.id}/messages`,
    {
      method: 'POST',
      headers: authHeader(buyer.body.token),
      body: { content: 'Buyer follow-up in existing sold conversation' }
    }
  );
  assert(buyerSoldFollowUp.status === 201, 'Existing sold-listing conversation blocked Buyer follow-up');
  const sellerSoldFollowUp = await request(
    `/api/conversations/${soldLaterConversation.body.conversation.id}/messages`,
    {
      method: 'POST',
      headers: authHeader(secondSeller.body.token),
      body: { content: 'Seller follow-up in existing sold conversation' }
    }
  );
  assert(sellerSoldFollowUp.status === 201, 'Existing sold-listing conversation blocked Seller reply');

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

  await dbRun('DELETE FROM messages WHERE sender_id = ?', [buyer.body.user.id]);
  const upgradedBuyerFollowUp = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeader(upgrade.body.token),
    body: { content: 'Buyer follow-up after upgrade' }
  });
  assert(upgradedBuyerFollowUp.status === 201,
    'Buyer participant lost conversation access after upgrading to Seller');

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

  const historyListing = await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [secondSeller.body.user.id, 'Deletion History Fixture', 'Conversation history fixture', 'Other', 45, 'Good', 'pickup', 'Campus']
  );
  const historyConversation = await dbRun(
    `INSERT INTO conversations
     (listing_id, listing_title_snapshot, buyer_id, seller_id, read_only, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [
      historyListing.lastID,
      'Deletion History Fixture',
      buyer.body.user.id,
      secondSeller.body.user.id,
      '2026-01-10T12:00:00.000Z',
      '2026-01-10T12:05:00.000Z'
    ]
  );
  await dbRun(
    'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
    [historyConversation.lastID, buyer.body.user.id, 'Buyer historical message', '2026-01-10T12:01:00.000Z']
  );
  await dbRun(
    'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
    [historyConversation.lastID, secondSeller.body.user.id, 'Seller historical message', '2026-01-10T12:02:00.000Z']
  );

  const historyDelete = await request(`/api/listings/${historyListing.lastID}`, {
    method: 'DELETE',
    headers: authHeader(secondSeller.body.token)
  });
  assert(historyDelete.status === 200, 'Deletion of listing with conversation history failed');

  const historyBuyerDetail = await request(`/api/conversations/${historyConversation.lastID}`, {
    headers: authHeader(buyer.body.token)
  });
  assert(historyBuyerDetail.status === 200, 'Buyer could not read retained deleted-listing history');
  assert(historyBuyerDetail.body.conversation.listing_id === null,
    'Retained conversation did not clear listing_id');
  assert(historyBuyerDetail.body.conversation.read_only === true,
    'Retained conversation was not read-only');

  const historySellerDetail = await request(`/api/conversations/${historyConversation.lastID}`, {
    headers: authHeader(secondSeller.body.token)
  });
  assert(historySellerDetail.status === 200, 'Seller could not read retained deleted-listing history');

  const historyBuyerMessages = await request(
    `/api/conversations/${historyConversation.lastID}/messages`,
    { headers: authHeader(buyer.body.token) }
  );
  assert(historyBuyerMessages.status === 200, 'Buyer could not retrieve retained message history');
  assert(historyBuyerMessages.body.messages.length === 2,
    'Deleted listing did not preserve existing message history');

  const historySellerMessages = await request(
    `/api/conversations/${historyConversation.lastID}/messages`,
    { headers: authHeader(secondSeller.body.token) }
  );
  assert(historySellerMessages.status === 200, 'Seller could not retrieve retained message history');
  assert(historySellerMessages.body.messages.length === 2,
    'Seller deleted-listing history response lost messages');

  const historyBuyerSend = await request(
    `/api/conversations/${historyConversation.lastID}/messages`,
    {
      method: 'POST',
      headers: authHeader(buyer.body.token),
      body: { content: 'Buyer send after deleted listing' }
    }
  );
  assert(historyBuyerSend.status === 409, 'Buyer could send after listing deletion');

  const historySellerSend = await request(
    `/api/conversations/${historyConversation.lastID}/messages`,
    {
      method: 'POST',
      headers: authHeader(secondSeller.body.token),
      body: { content: 'Seller send after deleted listing' }
    }
  );
  assert(historySellerSend.status === 409, 'Seller could send after listing deletion');

  const rollbackListing = await dbRun(
    'INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [secondSeller.body.user.id, 'Rollback Delete Fixture', 'Rollback deletion fixture', 'Other', 35, 'Good', 'pickup', 'Campus']
  );
  const rollbackConversation = await dbRun(
    `INSERT INTO conversations
     (listing_id, listing_title_snapshot, buyer_id, seller_id, read_only, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [
      rollbackListing.lastID,
      'Rollback Delete Fixture',
      buyer.body.user.id,
      secondSeller.body.user.id,
      '2026-01-11T12:00:00.000Z',
      '2026-01-11T12:05:00.000Z'
    ]
  );
  await dbRun(
    'INSERT INTO messages (conversation_id, sender_id, content, created_at) VALUES (?, ?, ?, ?)',
    [rollbackConversation.lastID, buyer.body.user.id, 'Rollback history message', '2026-01-11T12:01:00.000Z']
  );

  const rollbackListingBefore = await dbGet(
    'SELECT id, title FROM listings WHERE id = ?',
    [rollbackListing.lastID]
  );
  const rollbackConversationBefore = await dbGet(
    'SELECT listing_id, read_only, listing_title_snapshot, updated_at FROM conversations WHERE id = ?',
    [rollbackConversation.lastID]
  );
  const rollbackMessagesBefore = await dbAll(
    'SELECT id, conversation_id, sender_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id',
    [rollbackConversation.lastID]
  );

  await dbRun(`
    CREATE TRIGGER reject_transaction_listing_delete
    BEFORE DELETE ON listings
    WHEN OLD.title = 'Rollback Delete Fixture'
    BEGIN
      SELECT RAISE(FAIL, 'forced listing deletion test failure');
    END
  `);
  const rollbackDelete = await request(`/api/listings/${rollbackListing.lastID}`, {
    method: 'DELETE',
    headers: authHeader(secondSeller.body.token)
  });
  assert(rollbackDelete.status === 500, 'Forced listing deletion failure did not return HTTP 500');
  await dbRun('DROP TRIGGER reject_transaction_listing_delete');

  const rollbackListingAfter = await dbGet(
    'SELECT id, title FROM listings WHERE id = ?',
    [rollbackListing.lastID]
  );
  assert(rollbackListingAfter, 'Listing deletion rollback removed the listing');
  assert(JSON.stringify(rollbackListingAfter) === JSON.stringify(rollbackListingBefore),
    'Listing deletion rollback changed the listing fields');

  const rollbackConversationAfter = await dbGet(
    'SELECT listing_id, read_only, listing_title_snapshot, updated_at FROM conversations WHERE id = ?',
    [rollbackConversation.lastID]
  );
  assert(rollbackConversationAfter.listing_id === rollbackListing.lastID,
    'Listing deletion rollback lost the listing reference');
  assert(rollbackConversationAfter.read_only === rollbackConversationBefore.read_only,
    'Listing deletion rollback changed the conversation read-only state');
  assert(rollbackConversationAfter.listing_title_snapshot === rollbackConversationBefore.listing_title_snapshot,
    'Listing deletion rollback changed the conversation title snapshot');
  assert(rollbackConversationAfter.updated_at === rollbackConversationBefore.updated_at,
    'Listing deletion rollback changed conversation updated_at');

  const rollbackMessagesAfter = await dbAll(
    'SELECT id, conversation_id, sender_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id',
    [rollbackConversation.lastID]
  );
  assert(JSON.stringify(rollbackMessagesAfter) === JSON.stringify(rollbackMessagesBefore),
    'Listing deletion rollback changed existing message history');

  const sellerOwnDelete = await request(`/api/listings/${ownCreate.body.listing.id}`, {
    method: 'DELETE',
    headers: authHeader(seller.body.token)
  });
  assert(sellerOwnDelete.status === 200, 'Seller could not delete own listing');

  const deletedConversationDetail = await request(`/api/conversations/${concurrentConversationId}`, {
    headers: authHeader(buyer.body.token)
  });
  assert(deletedConversationDetail.status === 200, 'Buyer could not read deleted-listing conversation history');
  assert(deletedConversationDetail.body.conversation.listing_id === null,
    'Deleted-listing conversation retained a listing ID');
  assert(deletedConversationDetail.body.conversation.listing_title === ownCreate.body.listing.title ||
    deletedConversationDetail.body.conversation.listing_title === 'Updated Seller Item',
    'Deleted-listing conversation lost the title snapshot');
  assert(deletedConversationDetail.body.conversation.read_only === true,
    'Deleted-listing conversation was not read-only');

  const deletedConversationSellerDetail = await request(`/api/conversations/${concurrentConversationId}`, {
    headers: authHeader(seller.body.token)
  });
  assert(deletedConversationSellerDetail.status === 200,
    'Seller could not read deleted-listing conversation history');

  const deletedConversationSend = await request(
    `/api/conversations/${concurrentConversationId}/messages`,
    {
      method: 'POST',
      headers: authHeader(buyer.body.token),
      body: { content: 'Cannot send after deletion' }
    }
  );
  assert(deletedConversationSend.status === 409,
    'Deleted-listing conversation accepted a message');

  const upgradedCannotClaimBuyerCreate = await request('/api/listings', {
    method: 'POST',
    headers: authHeader(upgrade.body.token),
    body: { title: 'Upgraded Buyer Listing', description: 'Now allowed', category: 'Other', price: 15, condition: 'Good', deliveryMode: 'pickup', location: 'Campus' }
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
  console.log('Student Marketplace API tests passed');
}

run().catch(async (error) => {
  await stopServer();
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  console.error(error.message);
  process.exit(1);
});
