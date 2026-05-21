# Mast Netlify + Replit Deployment

## Frontend: Netlify

Set this environment variable in Netlify:

```text
VITE_API_URL=https://your-replit-backend.replit.app
```

Deploy from `frontend-src/mast-os-main`. The frontend calls the Replit API directly with credentialed requests.

## Backend: Replit

Set these environment variables in Replit:

```text
DATABASE_URL=postgres://...
SESSION_SECRET=long-random-secret
ALLOWED_ORIGIN=https://your-mast-site.netlify.app
FRONTEND_URL=https://your-mast-site.netlify.app
BACKEND_PUBLIC_URL=https://your-replit-backend.replit.app
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SCRAPER_API_URL=
SCRAPER_GENERATE_PATH=/leads/generate
SCRAPER_API_KEY=
```

Google OAuth redirect URI:

```text
https://your-replit-backend.replit.app/api/auth/google/callback
```

Keep the frontend and backend on HTTPS in production. Cross-site sessions use secure cookies and `credentials: "include"` from the frontend.
