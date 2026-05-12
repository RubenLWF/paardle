# Paardle

A TypeScript Wordle clone where the answer is always **PAARD**.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Run with Docker Compose

```bash
docker compose up --build
```

Open `http://localhost:5173`.

## Rules

- One game per day.
- Day rollover happens at **00:00 Europe/Amsterdam**.
- Previous daily results are stored in browser local storage.
