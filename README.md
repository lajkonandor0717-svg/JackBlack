# Blackjack — Pixelasztal

## Futtatás

Node.js 20 vagy újabb verzió szükséges. A projekt nem igényel külső npm-csomagokat.

```text
node server.js
```

Ezután nyisd meg a `http://localhost:3000` címet. Ugyanez a szerver az `npm start` paranccsal is indítható. A portot a `PORT` környezeti változóval lehet beállítani.

## Távoli játék

Telepítsd a teljes `blackjack` mappát egy Node.js-t futtató tárhelyre, és állítsd be a start parancsot `npm start`-ra. A szerver a szolgáltatótól kapott `PORT` porton, `0.0.0.0` címen figyel. HTTPS-t biztosító tárhelyet válassz; az alkalmazás maga ugyanazon a címen szolgálja ki a weboldalt és az API-t.

Barátokkal játszva egy asztal legfeljebb 7 játékost fogad. A házigazda megosztja az 5 karakteres szobakódot; a többiek a tárhely URL-jét megnyitva csatlakozhatnak. Egyjátékos módban 1–4 gépi ellenfél választható.

A téteket a házigazda kezdi, utána a csatlakozási sorrend következik. Egyszerre csak a soron következő játékos módosíthatja és adhatja le a tétjét; erre 30 másodperce van. A határidőt túllépő játékos kikerül az asztaltól. Ha mindenki leadta a tétjét, a kör automatikusan elindul. A következő körben a tétadási sorrend újraindul.

**Üzemeltetési megjegyzés:** a szobák memóriában élnek, ezért a szerver újraindítása lezárja az éppen futó asztalokat. Több szerverpéldány vagy tartós, újraindítás után is megmaradó szobák támogatásához később közös adatbázisra és eseményközvetítőre lesz szükség.

## Játékszabályok

- Körönként egy frissen megkevert, 52 lapos, joker nélküli pakli.
- Mindenki 100 virtuális zsetonnal kezd; a legkisebb tét 2 zseton, páros összegben választható a 3:2 blackjack-kifizetés miatt.
- Az osztó 17-től megáll; blackjack 3:2, nyerő kéz 1:1, döntetlen visszafizeti a tétet.
- Duplázás a kezdő két lap után, egy lapot húzva; páros rang esetén legfeljebb négy kézig lehet splitelni. Splitelt ászra egy lap kerül.
- Valódi pénz nincs használatban. A szerver kezeli a paklit, és játék közben nem küldi el az osztó rejtett lapját vagy a pakli sorrendjét a böngészőnek.

## Ellenőrzés

```text
node --test
```
