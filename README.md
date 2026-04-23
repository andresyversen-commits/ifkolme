# Lagval – Olme IF

Enkel webbapp för matchuttagning (2015/2016), utan inloggning. Data sparas i `data.json` i projektmappen.

## Krav

- [Node.js](https://nodejs.org/) 18 eller senare

## Installera och kör utveckling

```bash
cd OlmeIF
npm install
npm run dev
```

- Frontend: [http://localhost:5320](http://localhost:5320)
- API (standard): [http://localhost:37831](http://localhost:37831) – sätt `PORT` om du vill byta port (samma värde för Vite-proxy: uppdatera `vite.config.js` om du inte använder standarden).

Vite proxar `/api` till servern.

## Fler tränare (gemensam data)

- Produktionsapp: [https://ifkolme-production.up.railway.app/](https://ifkolme-production.up.railway.app/)
- Alla enheter (mobil/PC) ska använda **samma URL** ovan för att dela samma data.
- Klienten synkar automatiskt från servern vid fokus, online-händelse och periodiskt.
- `localStorage` används som offline-cache på varje enhet, men servern är sanningskälla.

### Rekommendation för säkerhet

- Exportera backup regelbundet från appen (**Exportera data**).
- Om ni använder Railway: se till att datalagring är persistent (volume/DB), annars kan filbaserad data återställas vid omstart/deploy.

## Bygga och köra produktion (en process)

```bash
npm install
npm run build
npm start
```

Öppna sedan [http://localhost:37831](http://localhost:37831) (API och statiska filer på samma port, eller den port du satt med `PORT`).

## Återställa data

Använd knappen **Återställ säsong** i appen, eller ta bort filen `data.json` och starta om servern (återskapas med startspelare).
