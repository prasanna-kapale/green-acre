# 🌿 The Green Acre — Farmhouse Booking System

A production-ready private farmhouse booking platform with dynamic pricing, WhatsApp-based confirmation, a live availability calendar, and a full manager admin panel.

---

## 📁 Project Structure

```
greenacre/
├── index.html              # Public landing page + booking flow
├── booking-status.html     # Guest booking status tracker
├── manager-login.html      # Manager login page
├── admin.html              # Manager admin dashboard
├── styles.css              # Shared stylesheet
├── config.js               # Frontend API base URL config
├── vercel.json             # Vercel deployment config (frontend)
├── .gitignore
│
└── backend/
    ├── server.js           # Express entry point + auto-release cron
    ├── schema.sql          # Complete PostgreSQL schema + seed data
    ├── package.json
    ├── railway.toml        # Railway deployment config
    ├── .env.example        # Environment variable template
    │
    ├── config/
    │   └── db.js           # PostgreSQL connection pool
    │
    ├── middleware/
    │   └── auth.js         # JWT authentication middleware
    │
    ├── routes/
    │   ├── auth.js         # POST /api/auth/login|logout, GET /api/auth/verify
    │   ├── public.js       # Calendar, pricing, bookings (public)
    │   └── admin.js        # Protected admin endpoints
    │
    └── utils/
        ├── helpers.js      # Ref generation, WhatsApp message builders, audit
        └── whatsapp.js     # Twilio WhatsApp sender (falls back to deep link)
```

---

## 🚀 Deployment

### Step 1 — Database (Supabase)

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and paste the full contents of `backend/schema.sql`
3. Run it — this creates all tables, indexes, seed data, and the default manager account
4. Copy your **Database URL** from Settings → Database

### Step 2 — Backend (Railway)

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Select the `backend/` folder as the root
3. Set environment variables (see below)
4. Railway auto-detects `railway.toml` and deploys

### Step 3 — Frontend (Vercel)

1. Go to [vercel.com](https://vercel.com) → New Project → Import GitHub repo
2. Set the **Root Directory** to `/` (project root, not `backend/`)
3. Vercel picks up `vercel.json` automatically
4. After backend is deployed, update `config.js` with your Railway URL

---

## 🔑 Required Environment Variables

Set these in Railway (backend):

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | Supabase PostgreSQL connection string | `postgresql://postgres:...@db.xxx.supabase.co:5432/postgres` |
| `JWT_SECRET` | 64-char random hex string | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `JWT_EXPIRES_IN` | Session duration | `8h` |
| `CORS_ORIGINS` | Comma-separated allowed origins | `https://yoursite.vercel.app` |
| `PORT` | Server port (Railway sets this) | `3001` |
| `NODE_ENV` | Environment | `production` |
| `MANAGER_WHATSAPP` | Manager's WhatsApp number | `+919876543210` |
| `AUTO_RELEASE_HOURS` | Hours before pending auto-releases | `48` |

Optional (for auto WhatsApp sending):

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_WHATSAPP_FROM` | Twilio sandbox number e.g. `whatsapp:+14155238886` |

---

## 🔐 Default Login

After running schema.sql, the default manager account is:

| Field | Value |
|---|---|
| Username | `manager@greenacre` |
| Password | `GreenAcre@2025` |

**⚠️ Change this password immediately after first login** via Settings → Change Password.

---

## 📋 API Reference

### Public

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/calendar?month=YYYY-MM` | Monthly calendar with slot status + rates |
| `GET` | `/api/pricing-rules?date=YYYY-MM-DD` | Rate for a specific date |
| `GET` | `/api/policy` | Guest-facing policy sections |
| `POST` | `/api/bookings/request` | Submit a new booking request |
| `GET` | `/api/bookings/:ref` | Look up booking by reference |
| `GET` | `/api/reviews` | Published reviews |

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Manager login → JWT |
| `POST` | `/api/auth/logout` | Clear session |
| `GET` | `/api/auth/verify` | Validate current token |

### Admin (JWT required)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/stats` | Dashboard stats |
| `GET` | `/api/admin/bookings` | All bookings (filterable) |
| `PATCH` | `/api/admin/bookings/:id/confirm` | Confirm booking |
| `PATCH` | `/api/admin/bookings/:id/release` | Release booking |
| `GET/POST` | `/api/admin/pricing-rules` | Manage date pricing |
| `PUT/DELETE` | `/api/admin/pricing-rules/:id` | Update/delete rule |
| `GET/PUT` | `/api/admin/default-rates` | Base weekday/weekend rates |
| `GET/POST/DELETE` | `/api/admin/blackouts` | Blackout date ranges |
| `GET/PUT` | `/api/admin/policy/:key` | Policy content |
| `GET/PATCH` | `/api/admin/content` | Property settings |
| `GET/PATCH` | `/api/admin/reviews/:id` | Review management |
| `GET` | `/api/admin/audit-logs` | Activity log |
| `POST` | `/api/admin/change-password` | Password change |

---

## 💡 Local Development

```bash
# 1. Clone and install backend
cd backend
npm install

# 2. Create local .env
cp .env.example .env
# Fill in DATABASE_URL and JWT_SECRET

# 3. Run schema on your DB
psql $DATABASE_URL < schema.sql

# 4. Start backend
npm start
# → Running on http://localhost:3001

# 5. Open frontend
# Open index.html in a browser (or use Live Server in VS Code)
# config.js auto-points to localhost:3001 when on localhost
```

---

## 🌐 Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL (Supabase)
- **Auth**: JWT (httpOnly cookie + Bearer header)
- **Notifications**: Twilio WhatsApp API (optional; falls back to deep links)
- **Hosting**: Vercel (frontend) + Railway (backend) + Supabase (database)
