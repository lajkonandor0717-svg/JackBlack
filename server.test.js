'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { createDeck, scoreHand, createServer } = require('./server');

test('a standard pakli 52 különböző, joker nélküli lapból áll', () => {
    const deck = createDeck();
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck.map((card) => `${card.rank}${card.suit}`)).size, 52);
    assert.ok(deck.every((card) => !['Joker', '★'].includes(card.rank)));
});

test('az ász értéke szükség esetén 11-ről 1-re vált', () => {
    assert.deepEqual(scoreHand([{ rank: 'A' }, { rank: '7' }]), { total: 18, soft: true });
    assert.deepEqual(scoreHand([{ rank: 'A' }, { rank: '7' }, { rank: '9' }]), { total: 17, soft: false });
    assert.deepEqual(scoreHand([{ rank: 'K' }, { rank: 'Q' }]), { total: 20, soft: false });
});

const servers = [];
let server;
let baseUrl;
after(async () => {
    await Promise.all(servers.map((item) => new Promise((resolve) => item.close(resolve))));
});

test('a szobák sorban kezelik a téteket, és minden játékos után automatikusan indulnak', async () => {
    server = createServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const createResponse = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Teszt', mode: 'friends' }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    const headers = { 'Content-Type': 'application/json', 'X-Player-Token': created.token };
    assert.equal(created.state.players.length, 1);
    assert.equal(created.state.players[0].chips, 100);
    assert.equal(created.state.bettingPlayerId, created.state.viewerId);
    assert.equal(created.state.bettingSecondsRemaining, null);

    const joinResponse = await fetch(`${baseUrl}/api/rooms/${created.code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Vendég' }),
    });
    assert.equal(joinResponse.status, 201);
    const guest = await joinResponse.json();
    assert.equal(guest.state.bettingPlayerId, created.state.viewerId);
    assert.ok(guest.state.bettingSecondsRemaining > 0);

    const earlyStart = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'start' }),
    });
    assert.equal(earlyStart.status, 400);

    const wrongTurnReady = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Token': guest.token },
        body: JSON.stringify({ type: 'ready' }),
    });
    assert.equal(wrongTurnReady.status, 400);

    const wrongTurnBet = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Token': guest.token },
        body: JSON.stringify({ type: 'bet', amount: 8 }),
    });
    assert.equal(wrongTurnBet.status, 400);

    const updateBet = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'bet', amount: 4 }),
    });
    assert.equal(updateBet.status, 200);
    assert.equal((await updateBet.json()).state.players[0].bet, 4);

    const ready = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'ready' }),
    });
    assert.equal(ready.status, 200);
    const waiting = (await ready.json()).state;
    assert.equal(waiting.phase, 'betting');
    assert.equal(waiting.bettingPlayerId, guest.state.viewerId);
    assert.ok(waiting.bettingSecondsRemaining > 0 && waiting.bettingSecondsRemaining <= 30);

    const hostBetAfterTurn = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'bet', amount: 6 }),
    });
    assert.equal(hostBetAfterTurn.status, 400);

    const guestReady = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Player-Token': guest.token },
        body: JSON.stringify({ type: 'ready' }),
    });
    assert.equal(guestReady.status, 200);
    const started = (await guestReady.json()).state;
    assert.ok(['playing', 'dealerTurn', 'roundEnd', 'gameOver'].includes(started.phase));
    assert.equal(started.bettingSecondsRemaining, null);
    assert.equal(started.players[0].chips, 96);
    assert.equal('deck' in started, false);
    assert.equal('token' in started.players[0], false);
    if (started.phase === 'playing') {
        assert.deepEqual(started.dealer.cards[1], { hidden: true });
    }

    const unauthorized = await fetch(`${baseUrl}/api/rooms/${created.code}/state`);
    assert.equal(unauthorized.status, 401);
});

test('a tétadási határidő csak a soron következő játékost távolítja el', async () => {
    const timeoutServer = createServer({ bettingTimeoutMs: 80 });
    servers.push(timeoutServer);
    await new Promise((resolve) => timeoutServer.listen(0, '127.0.0.1', resolve));
    const timeoutBaseUrl = `http://127.0.0.1:${timeoutServer.address().port}`;
    const createResponse = await fetch(`${timeoutBaseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Kész', mode: 'friends' }),
    });
    const created = await createResponse.json();
    const hostHeaders = { 'Content-Type': 'application/json', 'X-Player-Token': created.token };
    const joinResponse = await fetch(`${timeoutBaseUrl}/api/rooms/${created.code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Késlekedő' }),
    });
    const guest = await joinResponse.json();

    const readyResponse = await fetch(`${timeoutBaseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ type: 'ready' }),
    });
    const waiting = (await readyResponse.json()).state;
    assert.equal(waiting.phase, 'betting');
    assert.equal(waiting.bettingPlayerId, guest.state.viewerId);
    assert.ok(waiting.bettingSecondsRemaining > 0);
    assert.deepEqual(waiting.players.map((player) => player.name), ['Kész', 'Késlekedő']);

    await new Promise((resolve) => setTimeout(resolve, 120));
    const hostStateResponse = await fetch(`${timeoutBaseUrl}/api/rooms/${created.code}/state`, {
        headers: hostHeaders,
    });
    const started = (await hostStateResponse.json()).state;
    assert.deepEqual(started.players.map((player) => player.name), ['Kész']);
    assert.ok(['playing', 'dealerTurn', 'roundEnd', 'gameOver'].includes(started.phase));

    const removedGuestResponse = await fetch(`${timeoutBaseUrl}/api/rooms/${created.code}/state`, {
        headers: { 'X-Player-Token': guest.token },
    });
    assert.equal(removedGuestResponse.status, 401);
});

test('az osztó automatikusan felfedi és lejátsza a körét', async () => {
    const createResponse = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Osztóteszt', mode: 'friends' }),
    });
    const created = await createResponse.json();
    const headers = { 'Content-Type': 'application/json', 'X-Player-Token': created.token };
    const readyResponse = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'ready' }),
    });
    let state = (await readyResponse.json()).state;
    if (state.phase === 'playing') {
        const standResponse = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ type: 'stand' }),
        });
        state = (await standResponse.json()).state;
    }
    assert.equal(state.phase, 'dealerTurn');
    assert.ok(state.dealer.cards.every((card) => !card.hidden));

    const deadline = Date.now() + 25000;
    while (state.phase === 'dealerTurn' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const response = await fetch(`${baseUrl}/api/rooms/${created.code}/state`, { headers });
        state = (await response.json()).state;
    }
    assert.equal(state.phase, 'roundEnd', 'az osztó köre automatikusan lezárul');
    assert.equal(state.bettingPlayerId, created.state.viewerId);
    assert.ok(state.bettingSecondsRemaining > 0);

    const nextBet = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'bet', amount: 2 }),
    });
    assert.equal(nextBet.status, 200);
    const nextRound = await fetch(`${baseUrl}/api/rooms/${created.code}/action`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'ready' }),
    });
    assert.ok(['playing', 'dealerTurn'].includes((await nextRound.json()).state.phase));
});

test('az egyjátékos ellenfelek emberi neveket kapnak', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tesztelő', mode: 'solo', bots: 2 }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.deepEqual(created.state.players.slice(1).map((player) => player.name), ['Anna', 'Márton']);
});

test('egy baráti asztal legfeljebb hét játékost enged be', async () => {
    const createdResponse = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Házigazda', mode: 'friends' }),
    });
    const created = await createdResponse.json();
    for (let index = 1; index < 7; index += 1) {
        const joined = await fetch(`${baseUrl}/api/rooms/${created.code}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `Vendég ${index}` }),
        });
        assert.equal(joined.status, 201);
    }
    const fullTable = await fetch(`${baseUrl}/api/rooms/${created.code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hatodik' }),
    });
    assert.equal(fullTable.status, 400);
    assert.match((await fullTable.json()).error, /maximum 7/i);

    const soloResponse = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Egyedül', mode: 'solo', bots: 4 }),
    });
    const solo = await soloResponse.json();
    const soloJoin = await fetch(`${baseUrl}/api/rooms/${solo.code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Vendég' }),
    });
    assert.equal(soloJoin.status, 400);
    assert.match((await soloJoin.json()).error, /maximum 5/i);
});
