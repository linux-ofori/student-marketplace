const http = require('http');

const BASE_URL = 'http://localhost:5000';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.headers || {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const parsed = data ? JSON.parse(data) : {};
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

async function run() {
  const health = await request('/api/health');
  if (health.status !== 200) {
    throw new Error(`Health check failed: ${health.status}`);
  }

  const uniqueEmail = `teststudent_${Date.now()}@campus.edu`;

  const signup = await request('/api/auth/signup', {
    method: 'POST',
    body: {
      name: 'Test Student',
      email: uniqueEmail,
      password: 'student123',
      role: 'student'
    }
  });

  if (signup.status !== 201) {
    throw new Error(`Signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  }

  const listings = await request('/api/listings');
  if (listings.status !== 200) {
    throw new Error(`Listings fetch failed: ${listings.status}`);
  }

  const jobs = await request('/api/jobs');
  if (jobs.status !== 200) {
    throw new Error(`Jobs fetch failed: ${jobs.status}`);
  }

  const contact = await request('/api/contact', {
    method: 'POST',
    body: {
      name: 'Test Contact',
      email: 'test@example.com',
      message: 'This is a test message.'
    }
  });

  if (contact.status !== 201) {
    throw new Error(`Contact failed: ${contact.status} ${JSON.stringify(contact.body)}`);
  }

  console.log('API smoke tests passed');
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
