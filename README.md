# ZUUMLY Screen Assist

Screen Assist is a desktop-first AI helper built for BCIT Hackathon 2026.
It combines Electron, React, Firebase, and Groq to let users share their screen,
capture snapshots, and ask context-aware questions in chat or voice mode.

## Core Features

- Live screen capture preview
- Region selection for focused capture
- Snapshot gallery with attach/detach for chat context
- Streaming AI chat responses
- Voice mode (microphone transcription plus AI speech playback)
- Firebase authentication (login/signup/logout)
- Multi-chat history with Firestore persistence
- Settings page with chat cleanup and account deletion

## Tech Stack

- Electron (desktop shell and secure IPC bridge)
- Vite + React + TypeScript (renderer app)
- Firebase Auth + Firestore (accounts and chat storage)
- Groq SDK (chat, transcription, and TTS)
- Netlify Functions (web/server-side Groq fallback)

## Project Structure

```text
.
|-- electron/
|   |-- main.js
|   `-- preload.js
|-- netlify/
|   `-- functions/
|       |-- chat.mts
|       |-- transcribe.mts
|       `-- tts.mts
|-- src/
|   `-- renderer/
|       |-- pages/
|       |   |-- LandingPage.tsx
|       |   |-- AuthPage.tsx
|       |   `-- SettingsPage.tsx
|       |-- services/
|       |   |-- auth.ts
|       |   |-- chatService.ts
|       |   |-- firebase.ts
|       |   `-- model.ts
|       |-- App.tsx
|       |-- main.tsx
|       `-- styles.css
|-- index.html
|-- netlify.toml
|-- package.json
`-- tsconfig.json
```

## Prerequisites

- Node.js LTS
- npm
- A Groq API key
- A Firebase project (for auth and database)

## Environment Setup

1. Copy the example file:

PowerShell (Windows):

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

2. Fill in values in .env:

- `VITE_GROQ_API_KEY`: used by Electron renderer local mode
- `GROQ_API_KEY`: used by Netlify serverless functions
- `VITE_FIREBASE_API_KEY`
- `VITE_AUTH_DOMAIN`
- `VITE_PROJECT_ID`
- `VITE_STORAGE_BUCKET`
- `VITE_MESSAGING_SENDER_ID`
- `VITE_APP_ID`
- `VITE_MEASUREMENT_ID`

## Local Development

Install dependencies:

```bash
npm install
```

Start desktop development (Vite + Electron):

```bash
npm run dev
```

Build production web assets:

```bash
npm run build
```

Preview built assets:

```bash
npm run preview
```

Type check renderer code:

```bash
npm run typecheck
```

## Scripts

- `npm run dev`: runs Vite and launches Electron
- `npm run build`: creates production bundle in `dist/`
- `npm run preview`: serves the built `dist/` output
- `npm run typecheck`: runs TypeScript checks (`tsc --noEmit`)

## Runtime Modes

The app supports two Groq request paths:

- Electron local path:
	- When `VITE_GROQ_API_KEY` is present, renderer services call Groq SDK directly.
- Web/serverless path:
	- When direct SDK is unavailable, renderer calls `/api/*`.
	- `netlify.toml` routes `/api/chat`, `/api/transcribe`, and `/api/tts`
		to Netlify functions in `netlify/functions/`.

## Deploy Notes (Netlify)

- Build output directory: `dist`
- Functions directory: `netlify/functions`
- Required server-side secret: `GROQ_API_KEY`
- SPA routing and API redirects are configured in `netlify.toml`

## Notes

- Snapshots are temporarily stored by Electron in the OS temp directory.
- If you see large chunk warnings during Vite build, the build still succeeds;
	warnings are about bundle size optimization opportunities.
