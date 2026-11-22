const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

if (typeof JWT_SECRET !== 'string' || JWT_SECRET.trim().length === 0) {
  console.error('Configuration error: JWT_SECRET must be set to a non-empty value.');
  process.exit(1);
}

const dbPath = process.env.STUDENT_MARKET_DB_PATH
  ? path.resolve(process.env.STUDENT_MARKET_DB_PATH)
  : path.join(__dirname, 'data', 'student_marketplace.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);
const transactionStorage = new AsyncLocalStorage();
let databaseQueue = Promise.resolve();
let databaseFailure = null;

const fatalDatabaseCodes = new Set([
  'SQLITE_CANTOPEN',
  'SQLITE_CORRUPT',
  'SQLITE_INTERNAL',
  'SQLITE_IOERR',
  'SQLITE_MISUSE',
  'SQLITE_NOTADB',
  'SQLITE_PROTOCOL'
]);

function isFatalDatabaseError(error) {
  return Boolean(error && fatalDatabaseCodes.has(error.code));
}

function markDatabaseUnhealthy() {
  if (!databaseFailure) {
    databaseFailure = new Error('Database connection is unavailable.');
    databaseFailure.code = 'DATABASE_UNAVAILABLE';
  }
}

function ensureDatabaseHealthy() {
  if (databaseFailure) {
    throw databaseFailure;
  }
}

async function acquireDatabaseQueue() {
  const previous = databaseQueue;
  let release;
  databaseQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

async function withDatabaseQueue(operation) {
  const release = await acquireDatabaseQueue();
  try {
    ensureDatabaseHealthy();
    return await operation();
  } finally {
    release();
  }
}

function executeRun(sql, params = []) {
  ensureDatabaseHealthy();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        if (isFatalDatabaseError(error)) markDatabaseUnhealthy();
        reject(error);
        return;
      }
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function executeGet(sql, params = []) {
  ensureDatabaseHealthy();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        if (isFatalDatabaseError(error)) markDatabaseUnhealthy();
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function executeAll(sql, params = []) {
  ensureDatabaseHealthy();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        if (isFatalDatabaseError(error)) markDatabaseUnhealthy();
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

db.on('error', (error) => {
  if (isFatalDatabaseError(error)) markDatabaseUnhealthy();
});

function createTransactionContext() {
  const state = {
    acceptingQueries: true,
    inFlight: new Set(),
    failure: null
  };

  const executeScoped = (operation) => {
    if (!state.acceptingQueries) {
      return Promise.reject(new Error('Transaction is no longer accepting queries.'));
    }

    let query;
    try {
      ensureDatabaseHealthy();
      query = operation();
    } catch (error) {
      state.failure ||= error;
      return Promise.reject(error);
    }

    state.inFlight.add(query);
    query.then(
      () => state.inFlight.delete(query),
      (error) => {
        state.failure ||= error;
        state.inFlight.delete(query);
      }
    );
    query.catch(() => {});
    return query;
  };

  const context = {
    runQuery: (sql, params = []) => executeScoped(() => executeRun(sql, params)),
    getQuery: (sql, params = []) => executeScoped(() => executeGet(sql, params)),
    allQuery: (sql, params = []) => executeScoped(() => executeAll(sql, params)),
    async closeAndDrain() {
      state.acceptingQueries = false;
      while (state.inFlight.size) {
        await Promise.allSettled([...state.inFlight]);
      }
      return state.failure;
    }
  };

  return context;
}

async function withTransaction(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Transaction callback must be a function.');
  }
  if (transactionStorage.getStore()) {
    throw new Error('Nested database transactions are not supported.');
  }

  return withDatabaseQueue(async () => {
    let transactionStarted = false;
    let context;

    try {
      await executeRun('BEGIN IMMEDIATE');
      transactionStarted = true;
      context = createTransactionContext();

      const result = await transactionStorage.run(context, () => callback(context));
      const queryFailure = await context.closeAndDrain();
      if (queryFailure) throw queryFailure;

      await executeRun('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (context) {
        const queryFailure = await context.closeAndDrain();
        if (!error && queryFailure) error = queryFailure;
      }

      if (transactionStarted) {
        try {
          await executeRun('ROLLBACK');
          transactionStarted = false;
        } catch (rollbackError) {
          markDatabaseUnhealthy();
          throw databaseFailure;
        }
      }

      throw error;
    }
  });
}

const isStudentEmail = (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  return normalized.endsWith('.edu') || normalized.includes('student') || normalized.includes('campus');
};

const getUserSafe = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  student_verified: Boolean(user.student_verified)
});

const runQuery = (sql, params = []) => {
  const transaction = transactionStorage.getStore();
  if (transaction) return transaction.runQuery(sql, params);
  return withDatabaseQueue(() => executeRun(sql, params));
};

const getQuery = (sql, params = []) => {
  const transaction = transactionStorage.getStore();
  if (transaction) return transaction.getQuery(sql, params);
  return withDatabaseQueue(() => executeGet(sql, params));
};

const allQuery = (sql, params = []) => {
  const transaction = transactionStorage.getStore();
  if (transaction) return transaction.allQuery(sql, params);
  return withDatabaseQueue(() => executeAll(sql, params));
};

const createToken = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await getQuery('SELECT * FROM users WHERE id = ?', [decoded.id]);

    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

const sellerMiddleware = (req, res, next) => {
  if (req.user.role !== 'seller') {
    return res.status(403).json({ message: 'Seller account required.' });
  }
  next();
};

const listingFieldLimits = {
  title: 120,
  description: 2000,
  category: 60,
  location: 120
};
const listingConditions = new Set(['Excellent', 'Good', 'Fair', 'Poor']);
const listingDeliveryModes = new Set(['pickup', 'delivery']);
const listingStatuses = new Set(['active', 'sold']);
const publicListingSorts = {
  newest: 'l.created_at DESC, l.id DESC',
  lowest: 'l.price ASC, l.id ASC',
  highest: 'l.price DESC, l.id DESC'
};

function getPublicListing(listing) {
  if (!listing) return null;
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    category: listing.category,
    price: listing.price,
    condition: listing.condition,
    delivery_mode: listing.delivery_mode,
    location: listing.location,
    status: listing.status,
    created_at: listing.created_at,
    seller_name: listing.seller_name
  };
}

function validateListingInput(input, partial = false) {
  const errors = [];
  const values = {};

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { values, errors: ['Request body must be an object.'] };
  }

  const hasField = (field) => Object.prototype.hasOwnProperty.call(input, field);

  for (const [field, maxLength] of Object.entries({
    title: listingFieldLimits.title,
    description: listingFieldLimits.description,
    category: listingFieldLimits.category
  })) {
    if (!hasField(field)) {
      if (!partial) errors.push(`${field} is required.`);
      continue;
    }
    if (typeof input[field] !== 'string') {
      errors.push(`${field} must be a string.`);
      continue;
    }

    const value = input[field].trim();
    if (!value) errors.push(`${field} cannot be blank.`);
    else if (value.length > maxLength) errors.push(`${field} must be ${maxLength} characters or fewer.`);
    else values[field] = value;
  }

  if (!hasField('price')) {
    if (!partial) errors.push('price is required.');
  } else if (typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price <= 0) {
    errors.push('price must be a finite number greater than 0.');
  } else {
    values.price = input.price;
  }

  if (!hasField('condition')) {
    if (!partial) errors.push('condition is required.');
  } else if (typeof input.condition !== 'string' || !listingConditions.has(input.condition)) {
    errors.push('condition must be Excellent, Good, Fair, or Poor.');
  } else {
    values.condition = input.condition;
  }

  if (hasField('deliveryMode')) {
    if (typeof input.deliveryMode !== 'string' || !listingDeliveryModes.has(input.deliveryMode)) {
      errors.push('deliveryMode must be pickup or delivery.');
    } else {
      values.deliveryMode = input.deliveryMode;
    }
  } else if (!partial) {
    values.deliveryMode = 'pickup';
  }

  if (hasField('location')) {
    if (typeof input.location !== 'string') {
      errors.push('location must be a nonblank string.');
    } else {
      const location = input.location.trim();
      if (!location) {
        errors.push('location cannot be blank.');
      } else if (location.length > listingFieldLimits.location) {
        errors.push(`location must be ${listingFieldLimits.location} characters or fewer.`);
      } else {
        values.location = location;
      }
    }
  } else if (!partial) {
    errors.push('location is required.');
  }

  if (hasField('status')) {
    if (typeof input.status !== 'string' || !listingStatuses.has(input.status)) {
      errors.push('status must be active or sold.');
    } else {
      values.status = input.status;
    }
  }

  if (partial && Object.keys(values).length === 0 && errors.length === 0) {
    errors.push('At least one listing field must be provided.');
  }

  return { values, errors };
}

async function initializeDatabase() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      student_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS listings (
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

  await runQuery(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const foreignKeyViolations = await allQuery('PRAGMA foreign_key_check');
  if (foreignKeyViolations.length) {
    const details = foreignKeyViolations.map((violation) =>
      `${violation.table} row ${violation.row} references ${violation.parent} (constraint ${violation.fkid})`
    ).join('; ');
    throw new Error(`Foreign-key integrity check failed; existing records require review: ${details}`);
  }

  await runQuery('PRAGMA foreign_keys = ON');
  const foreignKeySetting = await getQuery('PRAGMA foreign_keys');
  if (!foreignKeySetting || foreignKeySetting.foreign_keys !== 1) {
    throw new Error('Could not enable SQLite foreign-key enforcement.');
  }

  await runQuery("UPDATE users SET role = 'buyer' WHERE role = 'student'");

  const userCount = await getQuery('SELECT COUNT(*) AS total FROM users');
  if (!userCount || userCount.total === 0) {
    const demoHash = await bcrypt.hash('student123', 10);
    await runQuery(
      'INSERT INTO users (name, email, password_hash, role, student_verified) VALUES (?, ?, ?, ?, ?)',
      ['Demo Student', 'demo@studentmarket.com', demoHash, 'buyer', 1]
    );
  }

  const listingCount = await getQuery('SELECT COUNT(*) AS total FROM listings');
  if (!listingCount || listingCount.total === 0) {
    const demoUser = await getQuery('SELECT id FROM users WHERE email = ?', ['demo@studentmarket.com']);

    if (demoUser) {
      await runQuery(
        `INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          demoUser.id,
          'Calculus Textbook',
          'Used textbook in very good condition with highlighted notes and practice solutions.',
          'Textbooks',
          25,
          'Good',
          'pickup',
          'Campus Center'
        ]
      );

      await runQuery(
        `INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          demoUser.id,
          'iPhone 11',
          'Unlocked smartphone with a screen protector and charging cable. Battery health is strong.',
          'Electronics',
          220,
          'Excellent',
          'delivery',
          'North Dorm'
        ]
      );
    }
  }

  const jobsCount = await getQuery('SELECT COUNT(*) AS total FROM jobs');
  if (!jobsCount || jobsCount.total === 0) {
    await runQuery(
      `INSERT INTO jobs (title, company, location, type, description) VALUES (?, ?, ?, ?, ?)`,
      ['Campus Ambassador', 'Student Life Office', 'Main Campus', 'Part-time', 'Represent the student community and assist with campus events and promotional campaigns.']
    );

    await runQuery(
      `INSERT INTO jobs (title, company, location, type, description) VALUES (?, ?, ?, ?, ?)`,
      ['Library Assistant', 'Campus Library', 'Library Annex', 'Part-time', 'Help students locate books, manage study spaces, and support quiet-hours desk operations.']
    );
  }
}

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (databaseFailure) {
    return res.status(503).json({ message: 'Database unavailable.' });
  }
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Student Marketplace backend',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, role } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedName = String(name).trim();

  if (normalizedName.length < 2) {
    return res.status(400).json({ message: 'Name must be at least 2 characters long.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
  }

  if (role !== 'buyer' && role !== 'seller') {
    return res.status(400).json({ message: 'Role must be either buyer or seller.' });
  }

  try {
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const studentVerified = isStudentEmail(normalizedEmail) ? 1 : 0;
    const newUser = await runQuery(
      'INSERT INTO users (name, email, password_hash, role, student_verified) VALUES (?, ?, ?, ?, ?)',
      [normalizedName, normalizedEmail, passwordHash, role, studentVerified]
    );

    const user = await getQuery('SELECT * FROM users WHERE id = ?', [newUser.id]);
    const token = createToken(user);

    return res.status(201).json({
      token,
      user: getUserSafe(user),
      message: studentVerified ? 'Student account created successfully.' : 'Account created. Student verification is pending review.'
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ message: 'Failed to create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const user = await getQuery('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const token = createToken(user);
    return res.json({
      token,
      user: getUserSafe(user)
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Failed to log in.' });
  }
});

app.get('/api/users/me', authMiddleware, async (req, res) => {
  res.json({ user: getUserSafe(req.user) });
});

app.post('/api/users/me/upgrade-to-seller', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'seller') {
      const token = createToken(req.user);
      return res.json({
        message: 'Your account is already a Seller account.',
        token,
        user: getUserSafe(req.user)
      });
    }

    if (req.user.role === 'student') {
      await runQuery("UPDATE users SET role = 'buyer' WHERE id = ?", [req.user.id]);
      req.user.role = 'buyer';
    }

    if (req.user.role !== 'buyer') {
      return res.status(409).json({ message: 'Unsupported account role; upgrade was not performed.' });
    }

    await runQuery("UPDATE users SET role = 'seller' WHERE id = ?", [req.user.id]);
    const updatedUser = await getQuery('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const token = createToken(updatedUser);

    return res.json({
      message: 'Account upgraded to Seller successfully.',
      token,
      user: getUserSafe(updatedUser)
    });
  } catch (error) {
    console.error('Seller upgrade error:', error);
    return res.status(500).json({ message: 'Could not upgrade account.' });
  }
});

app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const listings = await allQuery(
      `SELECT l.*, u.name AS seller_name
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC`,
      [user.id]
    );

    const recentActivity = user.role === 'seller' && listings.length
      ? [{ text: `Latest listing: ${listings[0].title}`, time: listings[0].created_at }]
      : [];

    const stats = {
      totalListings: listings.length,
      activeListings: listings.filter((item) => item.status === 'active').length
    };

    res.json({
      user: getUserSafe(user),
      listings,
      stats,
      activity: recentActivity
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: 'Could not load dashboard.' });
  }
});

app.get('/api/listings', async (req, res) => {
  const { q = '', category = '', sort = 'newest' } = req.query;
  const sortFragment = publicListingSorts[String(sort)];

  if (!sortFragment) {
    return res.status(400).json({
      message: 'Invalid sort option.',
      allowedSorts: ['newest', 'lowest', 'highest']
    });
  }

  let sql = `
    SELECT l.id, l.title, l.description, l.category, l.price, l.condition,
           l.delivery_mode, l.location, l.status, l.created_at, u.name AS seller_name
    FROM listings l
    JOIN users u ON u.id = l.user_id
    WHERE l.status = 'active'
  `;
  const params = [];

  if (q) {
    sql += ' AND (LOWER(l.title) LIKE ? OR LOWER(l.description) LIKE ? OR LOWER(l.category) LIKE ?)';
    const queryTerm = `%${String(q).toLowerCase()}%`;
    params.push(queryTerm, queryTerm, queryTerm);
  }

  if (category && category !== 'All') {
    sql += ' AND LOWER(l.category) = ?';
    params.push(String(category).toLowerCase());
  }

  sql += ` ORDER BY ${sortFragment}`;

  try {
    const listings = await allQuery(sql, params);
    res.json({ listings: listings.map(getPublicListing) });
  } catch (error) {
    console.error('List listings error:', error);
    res.status(500).json({ message: 'Could not fetch listings.' });
  }
});

app.get('/api/listings/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const listing = await getQuery(
      `SELECT l.id, l.title, l.description, l.category, l.price, l.condition,
              l.delivery_mode, l.location, l.status, l.created_at, u.name AS seller_name
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.id = ?`,
      [id]
    );

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found.' });
    }

    return res.json({ listing: getPublicListing(listing) });
  } catch (error) {
    console.error('Get listing error:', error);
    return res.status(500).json({ message: 'Could not fetch listing.' });
  }
});

app.post('/api/listings', authMiddleware, sellerMiddleware, async (req, res) => {
  const validation = validateListingInput(req.body);
  if (validation.errors.length) {
    return res.status(400).json({ message: 'Invalid listing data.', errors: validation.errors });
  }

  try {
    const { title, description, category, price, condition, deliveryMode, location } = validation.values;
    const savedListing = await withTransaction(async () => {
      const listing = await runQuery(
        `INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          title,
          description,
          category,
          price,
          condition,
          deliveryMode,
          location
        ]
      );

      return getQuery('SELECT * FROM listings WHERE id = ?', [listing.id]);
    });

    return res.status(201).json({ message: 'Listing created successfully.', listing: savedListing });
  } catch (error) {
    console.error('Create listing error:', error);
    return res.status(500).json({ message: 'Could not create listing.' });
  }
});

app.put('/api/listings/:id', authMiddleware, sellerMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const existingListing = await getQuery('SELECT * FROM listings WHERE id = ?', [id]);
    if (!existingListing) {
      return res.status(404).json({ message: 'Listing not found.' });
    }

    if (existingListing.user_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only update your own listings.' });
    }

    const validation = validateListingInput(req.body, true);
    if (validation.errors.length) {
      return res.status(400).json({ message: 'Invalid listing data.', errors: validation.errors });
    }

    const updatedValues = {
      title: existingListing.title,
      description: existingListing.description,
      category: existingListing.category,
      price: existingListing.price,
      condition: existingListing.condition,
      deliveryMode: existingListing.delivery_mode,
      location: existingListing.location,
      status: existingListing.status,
      ...validation.values
    };

    await runQuery(
      `UPDATE listings
       SET title = ?, description = ?, category = ?, price = ?, condition = ?, delivery_mode = ?, location = ?, status = ?
       WHERE id = ?`,
      [
        updatedValues.title,
        updatedValues.description,
        updatedValues.category,
        updatedValues.price,
        updatedValues.condition,
        updatedValues.deliveryMode,
        updatedValues.location,
        updatedValues.status,
        id
      ]
    );

    const updatedListing = await getQuery('SELECT * FROM listings WHERE id = ?', [id]);
    return res.json({ message: 'Listing updated successfully.', listing: updatedListing });
  } catch (error) {
    console.error('Update listing error:', error);
    return res.status(500).json({ message: 'Could not update listing.' });
  }
});

app.delete('/api/listings/:id', authMiddleware, sellerMiddleware, async (req, res) => {
  const { id } = req.params;

  try {
    const existingListing = await getQuery('SELECT * FROM listings WHERE id = ?', [id]);
    if (!existingListing) {
      return res.status(404).json({ message: 'Listing not found.' });
    }

    if (existingListing.user_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only delete your own listings.' });
    }

    await runQuery('DELETE FROM listings WHERE id = ?', [id]);
    return res.json({ message: 'Listing deleted successfully.' });
  } catch (error) {
    console.error('Delete listing error:', error);
    return res.status(500).json({ message: 'Could not delete listing.' });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await allQuery('SELECT * FROM jobs ORDER BY created_at DESC');
    res.json({ jobs });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ message: 'Could not fetch jobs.' });
  }
});

app.post('/api/jobs', authMiddleware, async (req, res) => {
  const { title, company, location, type, description } = req.body || {};

  if (!title || !company || !type || !description) {
    return res.status(400).json({ message: 'Title, company, type, and description are required.' });
  }

  try {
    const job = await runQuery(
      'INSERT INTO jobs (title, company, location, type, description) VALUES (?, ?, ?, ?, ?)',
      [
        String(title).trim(),
        String(company).trim(),
        location ? String(location).trim() : null,
        String(type).trim(),
        String(description).trim()
      ]
    );

    const createdJob = await getQuery('SELECT * FROM jobs WHERE id = ?', [job.id]);
    res.status(201).json({ message: 'Job posted successfully.', job: createdJob });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({ message: 'Could not create job listing.' });
  }
});

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ message: 'Name, email, and message are required.' });
  }

  try {
    await runQuery(
      'INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)',
      [String(name).trim(), String(email).trim(), String(message).trim()]
    );

    return res.status(201).json({ message: 'Message sent successfully.' });
  } catch (error) {
    console.error('Contact error:', error);
    return res.status(500).json({ message: 'Could not send message.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Student Marketplace API running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
