const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'student-market-secret';

const dbPath = process.env.STUDENT_MARKET_DB_PATH
  ? path.resolve(process.env.STUDENT_MARKET_DB_PATH)
  : path.join(__dirname, 'data', 'student_marketplace.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

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

const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });

const getQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const allQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

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

    const recentActivity = [
      { text: `You listed "${listings[0]?.title || 'your latest item'}" on the marketplace.`, time: 'Today' },
      { text: `Your profile is ${user.student_verified ? 'student verified' : 'pending verification'}.`, time: 'Now' },
      { text: 'New campus inquiries can be answered from your dashboard.', time: 'This week' }
    ];

    const stats = {
      totalSales: listings.reduce((sum, item) => sum + Number(item.price || 0), 0),
      activeListings: listings.filter((item) => item.status !== 'sold').length,
      ordersPlaced: 12,
      walletBalance: Math.max(50, Math.round(listings.reduce((sum, item) => sum + Number(item.price || 0), 0) * 0.45))
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
  const { q = '', category = '', status = 'active' } = req.query;

  let sql = `
    SELECT l.*, u.name AS seller_name
    FROM listings l
    JOIN users u ON u.id = l.user_id
    WHERE l.status = ?
  `;
  const params = [status];

  if (q) {
    sql += ' AND (LOWER(l.title) LIKE ? OR LOWER(l.description) LIKE ? OR LOWER(l.category) LIKE ?)';
    const queryTerm = `%${String(q).toLowerCase()}%`;
    params.push(queryTerm, queryTerm, queryTerm);
  }

  if (category && category !== 'All') {
    sql += ' AND LOWER(l.category) = ?';
    params.push(String(category).toLowerCase());
  }

  sql += ' ORDER BY l.created_at DESC';

  try {
    const listings = await allQuery(sql, params);
    res.json({ listings });
  } catch (error) {
    console.error('List listings error:', error);
    res.status(500).json({ message: 'Could not fetch listings.' });
  }
});

app.get('/api/listings/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const listing = await getQuery(
      `SELECT l.*, u.name AS seller_name
       FROM listings l
       JOIN users u ON u.id = l.user_id
       WHERE l.id = ?`,
      [id]
    );

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found.' });
    }

    return res.json({ listing });
  } catch (error) {
    console.error('Get listing error:', error);
    return res.status(500).json({ message: 'Could not fetch listing.' });
  }
});

app.post('/api/listings', authMiddleware, sellerMiddleware, async (req, res) => {
  const { title, description, category, price, condition, deliveryMode, location } = req.body || {};

  if (!title || !description || !category || !price || !condition) {
    return res.status(400).json({ message: 'Title, description, category, price, and condition are required.' });
  }

  try {
    const listing = await runQuery(
      `INSERT INTO listings (user_id, title, description, category, price, condition, delivery_mode, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        String(title).trim(),
        String(description).trim(),
        String(category).trim(),
        Number(price),
        String(condition).trim(),
        deliveryMode || 'pickup',
        location ? String(location).trim() : null
      ]
    );

    const savedListing = await getQuery('SELECT * FROM listings WHERE id = ?', [listing.id]);
    return res.status(201).json({ message: 'Listing created successfully.', listing: savedListing });
  } catch (error) {
    console.error('Create listing error:', error);
    return res.status(500).json({ message: 'Could not create listing.' });
  }
});

app.put('/api/listings/:id', authMiddleware, sellerMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, description, category, price, condition, deliveryMode, location, status } = req.body || {};

  try {
    const existingListing = await getQuery('SELECT * FROM listings WHERE id = ?', [id]);
    if (!existingListing) {
      return res.status(404).json({ message: 'Listing not found.' });
    }

    if (existingListing.user_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only update your own listings.' });
    }

    await runQuery(
      `UPDATE listings
       SET title = ?, description = ?, category = ?, price = ?, condition = ?, delivery_mode = ?, location = ?, status = ?
       WHERE id = ?`,
      [
        title || existingListing.title,
        description || existingListing.description,
        category || existingListing.category,
        price !== undefined ? Number(price) : existingListing.price,
        condition || existingListing.condition,
        deliveryMode || existingListing.delivery_mode,
        location !== undefined ? String(location).trim() : existingListing.location,
        status || existingListing.status,
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
