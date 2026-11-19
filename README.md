# Student Marketplace Backend

This project adds a working backend API for the Student Marketplace website.

## Features

- Student sign up and login
- Email-based student verification
- Product listing creation/search
- Job listings management
- Contact message handling
- SQLite database persistence

## Quick start

```bash
npm install
npm start
```

The API will run on: http://localhost:5000

## Main endpoints

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/listings`
- `POST /api/listings`
- `GET /api/jobs`
- `POST /api/jobs`
- `POST /api/contact`

## Environment variables

- `PORT` — default 5000
- `JWT_SECRET` — default `student-market-secret`
