# MossHatch

MossHatch monorepo (npm workspaces, Node >= 22).

## Apps

- `apps/web` — main site
- `apps/cards` — cards app
- `apps/registrar` — registrar app

Shared code lives in `packages/*`.

## Develop

```bash
npm install
npm run dev
```

## Verify

```bash
npm run build
npm run typecheck
npm test
npm run test:e2e
```
