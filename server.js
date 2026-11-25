'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 7;
const MAX_SOLO_PLAYERS = 5;
const MIN_BET = 2;
const STARTING_CHIPS = 100;
const BETTING_TURN_TIMEOUT_MS = 30_000;
class RequestError extends Error {}

const rooms = new Map();
const botNames = ['Anna', 'Márton', 'Léna', 'Bence'];
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const roomAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomToken(bytes = 24) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function createDeck() {
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ rank, suit });
        }
    }

    for (let index = deck.length - 1; index > 0; index -= 1) {
        const swapIndex = crypto.randomInt(index + 1);
        [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
    }
    return deck;
}

function scoreHand(cards) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
        if (card.rank === 'A') {
            total += 11;
            aces += 1;
        } else if (['K', 'Q', 'J'].includes(card.rank)) {
            total += 10;
        } else {
            total += Number(card.rank);
        }
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }
    return { total, soft: aces > 0 };
}

function draw(room) {
    if (room.deck.length === 0) {
        throw new Error('Elfogyott a pakli ebben a körben.');
    }
    return room.deck.pop();
}

function handState(cards, bet, options = {}) {
    return {
        cards,
        bet,
        doubled: false,
        fromSplit: false,
        natural: false,
        status: 'playing',
        result: '',
        ...options,
    };
}

function activePlayers(room) {
    return room.players.filter((player) => !player.eliminated);
}

function activeHumanPlayers(room) {
    return room.players.filter((player) => !player.isBot && !player.eliminated);
}

function roomIsIdle(room) {
    return ['lobby', 'betting', 'roundEnd'].includes(room.phase);
}

function clearBettingTimer(room) {
    if (room.bettingTimer) clearTimeout(room.bettingTimer);
    room.bettingTimer = null;
    room.bettingDeadline = null;
}

function ensureHost(room) {
    if (room.players.some((player) => player.isHost && !player.eliminated)) return;
    for (const player of room.players) player.isHost = false;
    const newHost = activeHumanPlayers(room)[0] || room.players[0];
    if (newHost) newHost.isHost = true;
}

function expireBettingTurn(room) {
    room.bettingTimer = null;
    room.bettingDeadline = null;
    if (!roomIsIdle(room)) return;

    const latePlayer = room.players.find((player) => player.id === room.bettingPlayerId);
    if (!latePlayer || latePlayer.isBot || latePlayer.eliminated || latePlayer.ready) {
        advanceBettingTurn(room);
        return;
    }

    room.players = room.players.filter((player) => player !== latePlayer);
    ensureHost(room);
    if (activeHumanPlayers(room).length === 0) {
        rooms.delete(room.code);
        return;
    }

    room.phase = 'betting';
    advanceBettingTurn(room);
}

function startBettingTimer(room) {
    clearBettingTimer(room);
    if (!room.bettingPlayerId) return;
    room.bettingDeadline = Date.now() + room.bettingTimeoutMs;
    room.bettingTimer = setTimeout(() => expireBettingTurn(room), room.bettingTimeoutMs);
    room.bettingTimer.unref();
}

function advanceBettingTurn(room, startTimer = true) {
    if (!roomIsIdle(room)) {
        clearBettingTimer(room);
        room.bettingPlayerId = null;
        return;
    }

    const nextPlayer = activeHumanPlayers(room).find((player) => !player.ready);
    if (!nextPlayer) {
        clearBettingTimer(room);
        room.bettingPlayerId = null;
        if (activeHumanPlayers(room).length === 0) {
            rooms.delete(room.code);
            return;
        }
        startRound(room);
        return;
    }

    if (room.bettingPlayerId === nextPlayer.id && room.bettingTimer) return;
    clearBettingTimer(room);
    room.bettingPlayerId = nextPlayer.id;
    if (startTimer && room.phase !== 'lobby') startBettingTimer(room);
}

function currentBettingPlayer(room) {
    return room.players.find((player) => player.id === room.bettingPlayerId) || null;
}

function requireBettingTurn(room, player) {
    if (currentBettingPlayer(room) !== player || player.ready) {
        throw new RequestError('Most nem te következel a tétadásban.');
    }
}

function createPlayer(name, options = {}) {
    return {
        id: randomToken(12),
        token: randomToken(),
        name: name.trim().slice(0, 20),
        chips: STARTING_CHIPS,
        bet: 0,
        ready: options.isBot === true,
        isBot: options.isBot === true,
        isHost: options.isHost === true,
        eliminated: false,
        hands: [],
    };
}

function makeRoomCode() {
    let code;
    do {
        code = Array.from({ length: 5 }, () => roomAlphabet[crypto.randomInt(roomAlphabet.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function makeRoom(name, mode, botCount) {
    const code = makeRoomCode();
    const host = createPlayer(name, { isHost: true });
    host.bet = MIN_BET;
    const room = {
        code,
        mode,
        maxPlayers: mode === 'friends' ? MAX_PLAYERS : MAX_SOLO_PLAYERS,
        phase: 'lobby',
        players: [host],
        dealer: [],
        deck: [],
        turnIndex: 0,
        handIndex: 0,
        lastResults: [],
        error: '',
        createdAt: Date.now(),
        bettingPlayerId: host.id,
        bettingTimer: null,
        bettingDeadline: null,
        bettingTimeoutMs: BETTING_TURN_TIMEOUT_MS,
    };
    if (mode === 'solo') {
        for (let index = 0; index < botCount; index += 1) {
            room.players.push(createPlayer(botNames[index], { isBot: true }));
        }
        for (const player of room.players) {
            player.bet = MIN_BET;
        }
    }
    rooms.set(code, room);
    return { room, player: host };
}

function getPlayer(room, token) {
    if (typeof token !== 'string' || token.length < 20) {
        return null;
    }
    return room.players.find((player) => player.token === token) || null;
}

function publicCard(card) {
    return { rank: card.rank, suit: card.suit };
}

function publicState(room, viewer) {
    const dealerCards = room.dealer.map((card, index) => {
        if (room.phase === 'playing' && index === 1) {
            return { hidden: true };
        }
        return publicCard(card);
    });
    const currentPlayer = room.players[room.turnIndex];
    return {
        code: room.code,
        mode: room.mode,
        phase: room.phase,
        error: room.error,
        maxPlayers: room.maxPlayers,
        minBet: MIN_BET,
        bettingPlayerId: room.bettingPlayerId,
        bettingSecondsRemaining: room.bettingDeadline === null
            ? null
            : Math.max(0, Math.ceil((room.bettingDeadline - Date.now()) / 1000)),
        viewerId: viewer.id,
        hostId: room.players.find((player) => player.isHost)?.id || null,
        players: room.players.map((player) => ({
            id: player.id,
            name: player.name,
            chips: player.chips,
            bet: player.bet,
            ready: player.ready,
            isBot: player.isBot,
            isHost: player.isHost,
            eliminated: player.eliminated,
            hands: player.hands.map((hand) => ({
                cards: hand.cards.map(publicCard),
                bet: hand.bet,
                doubled: hand.doubled,
                fromSplit: hand.fromSplit,
                natural: hand.natural,
                status: hand.status,
                result: hand.result,
                total: scoreHand(hand.cards).total,
                soft: scoreHand(hand.cards).soft,
            })),
        })),
        dealer: {
            cards: dealerCards,
            total: room.phase === 'playing' ? scoreHand(room.dealer.slice(0, 1)).total : scoreHand(room.dealer).total,
            soft: room.phase === 'playing' ? scoreHand(room.dealer.slice(0, 1)).soft : scoreHand(room.dealer).soft,
        },
        currentPlayerId: room.phase === 'playing' && currentPlayer ? currentPlayer.id : null,
        currentHandIndex: room.phase === 'playing' ? room.handIndex : null,
        lastResults: room.lastResults,
    };
}

function currentHand(room) {
    const player = room.players[room.turnIndex];
    const hand = player && player.hands[room.handIndex];
    return { player, hand };
}

function pairCanSplit(hand) {
    return hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank;
}

function botDecision(hand, dealerUpCard) {
    const { total, soft } = scoreHand(hand.cards);
    const dealerValue = dealerUpCard.rank === 'A' ? 11 : (['K', 'Q', 'J'].includes(dealerUpCard.rank) ? 10 : Number(dealerUpCard.rank));

    if (hand.cards.length === 2 && total >= 9 && total <= 11) {
        const shouldDouble = (total === 11) ||
            (total === 10 && dealerValue < 10) ||
            (total === 9 && dealerValue >= 3 && dealerValue <= 6);
        if (shouldDouble) return 'double';
    }

    if (pairCanSplit(hand) && ['A', '8'].includes(hand.cards[0].rank)) return 'split';
    if (total < 12) return 'hit';
    if (total >= 17) return 'stand';
    if (soft && total <= 18) return 'hit';
    if (total >= 13 && dealerValue <= 6) return 'stand';
    return 'hit';
}

function advanceToNextHuman(room, movePastCurrent = false) {
    if (movePastCurrent) {
        room.handIndex += 1;
    }
    let steps = 0;
    const maxSteps = 520;
    while (steps < maxSteps) {
        steps += 1;
        const player = room.players[room.turnIndex];
        if (!player) {
            startDealerTurn(room);
            return;
        }
        if (room.handIndex >= player.hands.length) {
            room.turnIndex += 1;
            room.handIndex = 0;
            continue;
        }
        const hand = player.hands[room.handIndex];
        if (hand.status !== 'playing') {
            room.handIndex += 1;
            continue;
        }
        if (!player.isBot) return;

        const decision = botDecision(hand, room.dealer[0]);
        applyHandAction(room, player, hand, decision);
        if (hand.status === 'playing') {
            continue;
        }
        room.handIndex += 1;
    }
    throw new Error('A kör léptetése nem fejeződött be.');
}

function applyHandAction(room, player, hand, action) {
    if (action === 'hit') {
        hand.cards.push(draw(room));
        if (scoreHand(hand.cards).total > 21) {
            hand.status = 'bust';
        }
        return;
    }
    if (action === 'stand') {
        hand.status = 'stand';
        return;
    }
    if (action === 'double') {
        if (hand.cards.length !== 2 || player.chips < hand.bet || hand.fromSplit && hand.cards[0].rank === 'A') {
            throw new RequestError('Ezt a kezet nem lehet megduplázni.');
        }
        player.chips -= hand.bet;
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(draw(room));
        hand.status = scoreHand(hand.cards).total > 21 ? 'bust' : 'stand';
        return;
    }
    if (action === 'split') {
        if (!pairCanSplit(hand) || player.chips < hand.bet || player.hands.length >= 4) {
            throw new RequestError('Ez a pár nem osztható tovább.');
        }
        player.chips -= hand.bet;
        const [first, second] = hand.cards;
        const isAce = first.rank === 'A';
        hand.cards = [first, draw(room)];
        hand.fromSplit = true;
        hand.natural = false;
        const splitHand = handState([second, draw(room)], hand.bet, {
            fromSplit: true,
            status: isAce ? 'stand' : 'playing',
        });
        if (isAce) hand.status = 'stand';
        player.hands.splice(player.hands.indexOf(hand) + 1, 0, splitHand);
        return;
    }
    throw new Error('Ismeretlen lépés.');
}

function settleRound(room) {
    const dealerScore = scoreHand(room.dealer).total;
    const dealerBust = dealerScore > 21;
    const dealerNatural = room.dealer.length === 2 && dealerScore === 21;
    const results = [];

    for (const player of activePlayers(room)) {
        for (const hand of player.hands) {
            const score = scoreHand(hand.cards).total;
            const natural = hand.natural && !hand.fromSplit;
            let payout = 0;
            let result;
            if (hand.status === 'bust') {
                result = 'Vesztett';
            } else if (natural && dealerNatural) {
                payout = hand.bet;
                result = 'Döntetlen';
            } else if (natural) {
                payout = hand.bet * 2.5;
                result = 'Blackjack! +3:2';
            } else if (dealerNatural) {
                result = 'Az osztónak blackjack';
            } else if (dealerBust || score > dealerScore) {
                payout = hand.bet * 2;
                result = 'Nyert';
            } else if (score === dealerScore) {
                payout = hand.bet;
                result = 'Döntetlen';
            } else {
                result = 'Vesztett';
            }
            if (!Number.isInteger(payout)) {
                throw new Error('A blackjack-kifizetéshez páros tét szükséges.');
            }
            player.chips += payout;
            hand.status = 'complete';
            hand.result = result;
            results.push({ playerId: player.id, playerName: player.name, result, payout });
        }
    }

    room.lastResults = results;
    for (const player of room.players) {
        if (player.chips < MIN_BET) {
            player.eliminated = true;
        } else {
            player.bet = player.isBot ? MIN_BET : 0;
            player.ready = player.isBot;
        }
    }
    room.phase = 'roundEnd';
    room.bettingPlayerId = activeHumanPlayers(room)[0]?.id || null;
    if (activePlayers(room).length === 0 || !room.players.some((player) => !player.isBot && !player.eliminated)) {
        room.phase = 'gameOver';
        room.bettingPlayerId = null;
    } else {
        startBettingTimer(room);
    }
}

function startDealerTurn(room) {
    if (room.phase === 'dealerTurn') return;
    room.phase = 'dealerTurn';
    room.error = '';
    const playDealerTurn = async () => {
        while (scoreHand(room.dealer).total < 17) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            room.dealer.push(draw(room));
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        settleRound(room);
    };
    playDealerTurn().catch((error) => {
        console.error('Az osztó köre nem fejeződött be:', error);
        room.error = 'Az osztó köre közben hiba történt. Próbálj új játékot indítani.';
    });
}

function startRound(room) {
    if (!roomIsIdle(room)) throw new RequestError('A kör már folyamatban van.');
    const players = activePlayers(room);
    if (players.length === 0) throw new RequestError('Nincs játékban lévő játékos.');
    if (activeHumanPlayers(room).some((player) => !player.ready)) {
        throw new RequestError('Várjuk meg, amíg mindenki beállítja a tétjét.');
    }
    for (const player of players) {
        if (!Number.isInteger(player.bet) || player.bet < MIN_BET || player.bet % 2 !== 0 || player.bet > player.chips) {
            throw new RequestError(`${player.name}: a tét legyen páros, legalább 2, és ne legyen több a zsetonok számánál.`);
        }
    }
    clearBettingTimer(room);
    room.bettingPlayerId = null;
    for (const player of room.players) player.hands = [];
    room.lastResults = [];
    room.error = '';
    room.deck = createDeck();
    room.dealer = [];
    for (const player of players) {
        player.chips -= player.bet;
        player.hands.push(handState([], player.bet));
    }
    for (let round = 0; round < 2; round += 1) {
        for (const player of players) player.hands[0].cards.push(draw(room));
        room.dealer.push(draw(room));
    }
    room.phase = 'playing';
    for (const player of players) {
        const hand = player.hands[0];
        const score = scoreHand(hand.cards).total;
        if (score === 21) {
            hand.natural = true;
            hand.status = 'stand';
        }
    }
    room.turnIndex = 0;
    room.handIndex = 0;
    if (room.dealer.length === 2 && scoreHand(room.dealer).total === 21) {
        startDealerTurn(room);
        return;
    }
    advanceToNextHuman(room);
}

function handleAction(room, player, body) {
    if (body.type === 'bet') {
        if (!roomIsIdle(room) || player.eliminated || player.isBot) {
            throw new RequestError('Most nem lehet tétet módosítani.');
        }
        requireBettingTurn(room, player);
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount < MIN_BET || amount % 2 !== 0 || amount > player.chips) {
            throw new RequestError(`A tét 2 vagy több, páros számú zseton lehet; neked ${player.chips} van.`);
        }
        player.bet = amount;
        room.phase = 'betting';
        if (!room.bettingTimer) startBettingTimer(room);
        return;
    }
    if (body.type === 'ready') {
        if (!roomIsIdle(room) || player.eliminated || player.isBot) throw new RequestError('Most nem lehet készenlétet állítani.');
        requireBettingTurn(room, player);
        if (player.bet < MIN_BET || player.bet > player.chips) throw new RequestError('Előbb válassz érvényes tétet.');
        player.ready = true;
        room.phase = 'betting';
        advanceBettingTurn(room);
        return;
    }
    if (body.type === 'start') {
        if (!player.isHost) throw new RequestError('A kört csak a házigazda indíthatja el.');
        startRound(room);
        return;
    }
    if (body.type === 'leave') {
        if (!roomIsIdle(room)) throw new RequestError('Kiszállni csak két kör között lehet.');
        const wasBettingPlayer = room.bettingPlayerId === player.id;
        const previousPhase = room.phase;
        room.players = room.players.filter((item) => item !== player);
        ensureHost(room);
        if (activeHumanPlayers(room).length === 0) {
            clearBettingTimer(room);
            rooms.delete(room.code);
        } else if (wasBettingPlayer) {
            if (previousPhase === 'lobby') room.phase = 'lobby';
            else room.phase = 'betting';
            advanceBettingTurn(room, previousPhase !== 'lobby');
        }
        return;
    }
    if (body.type === 'hit' || body.type === 'stand' || body.type === 'double' || body.type === 'split') {
        if (room.phase !== 'playing') throw new RequestError('Most nem lehet lapot kérni.');
        const { player: actingPlayer, hand } = currentHand(room);
        if (actingPlayer !== player || player.isBot || !hand || hand.status !== 'playing') {
            throw new RequestError('Most nem te következel.');
        }
        if (body.type === 'split' && (player.chips < hand.bet || player.hands.length >= 4)) {
            throw new RequestError('Ehhez a splithez nincs elég zseton vagy elérted a kézlimitet.');
        }
        applyHandAction(room, player, hand, body.type);
        if (hand.status !== 'playing') advanceToNextHuman(room, true);
        return;
    }
    throw new RequestError('Ismeretlen művelet.');
}

function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    });
    response.end(body);
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', (chunk) => {
            body += chunk;
            if (Buffer.byteLength(body) > 8192) {
                reject(new RequestError('A kérés túl nagy.'));
                request.destroy();
            }
        });
        request.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new RequestError('Érvénytelen JSON kérés.'));
            }
        });
        request.on('error', reject);
    });
}

function createServer({ bettingTimeoutMs = BETTING_TURN_TIMEOUT_MS } = {}) {
    if (!Number.isInteger(bettingTimeoutMs) || bettingTimeoutMs <= 0) {
        throw new TypeError('A tétadási időtúllépés pozitív egész szám legyen.');
    }
    return http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (request.method === 'GET' && url.pathname === '/api/health') {
            sendJson(response, 200, { ok: true });
            return;
        }
        if (url.pathname.startsWith('/api/')) {
            try {
                if (request.method === 'POST' && url.pathname === '/api/rooms') {
                    const body = await readJson(request);
                    const name = typeof body.name === 'string' ? body.name.trim() : '';
                    if (!['solo', 'friends'].includes(body.mode)) throw new RequestError('Válassz érvényes játékmódot.');
                    const mode = body.mode;
                    const botCount = Number(body.bots);
                    if (!name || name.length > 20) throw new RequestError('Adj meg egy 1–20 karakteres becenevet.');
                    if (mode === 'solo' && (!Number.isInteger(botCount) || botCount < 1 || botCount > 4)) {
                        throw new RequestError('Az ellenfelek száma 1 és 4 között lehet.');
                    }
                    const { room, player } = makeRoom(name, mode, mode === 'solo' ? botCount : 0);
                    room.bettingTimeoutMs = bettingTimeoutMs;
                    sendJson(response, 201, { code: room.code, token: player.token, state: publicState(room, player) });
                    return;
                }

                const match = url.pathname.match(/^\/api\/rooms\/([A-Z2-9]+)(?:\/(join|action|leave|state))?$/);
                if (!match) {
                    sendJson(response, 404, { error: 'Nem található API végpont.' });
                    return;
                }
                const [, code, operation] = match;
                const room = rooms.get(code);
                if (!room) {
                    sendJson(response, 404, { error: 'Ez a szoba már nem létezik.' });
                    return;
                }
                if (request.method === 'POST' && operation === 'join') {
                    const body = await readJson(request);
                    const name = typeof body.name === 'string' ? body.name.trim() : '';
                    if (!name || name.length > 20) throw new RequestError('Adj meg egy 1–20 karakteres becenevet.');
                    if (!roomIsIdle(room)) throw new RequestError('A játék már elkezdődött, most nem lehet csatlakozni.');
                    if (room.players.length >= room.maxPlayers) {
                        throw new RequestError(`Ez az asztal megtelt (maximum ${room.maxPlayers} játékos).`);
                    }
                    const player = createPlayer(name);
                    player.bet = MIN_BET;
                    room.players.push(player);
                    if (room.bettingPlayerId && !room.bettingTimer) {
                        room.phase = 'betting';
                        startBettingTimer(room);
                    }
                    sendJson(response, 201, { code: room.code, token: player.token, state: publicState(room, player) });
                    return;
                }

                const player = getPlayer(room, request.headers['x-player-token']);
                if (!player) {
                    sendJson(response, 401, { error: 'A szoba eléréséhez érvényes játékos-token szükséges.' });
                    return;
                }
                if (request.method === 'GET' && (!operation || operation === 'state')) {
                    sendJson(response, 200, { state: publicState(room, player) });
                    return;
                }
                if (request.method === 'POST' && operation === 'action') {
                    const body = await readJson(request);
                    handleAction(room, player, body);
                    sendJson(response, 200, { state: publicState(room, player) });
                    return;
                }
                if (request.method === 'POST' && operation === 'leave') {
                    handleAction(room, player, { type: 'leave' });
                    sendJson(response, 200, { ok: true });
                    return;
                }
                sendJson(response, 405, { error: 'Ez a művelet nem támogatott.' });
            } catch (error) {
                if (!response.headersSent && !response.destroyed) {
                    if (error instanceof RequestError) {
                        sendJson(response, 400, { error: error.message });
                    } else {
                        console.error('Blackjack API hiba:', error);
                        sendJson(response, 500, { error: 'Belső szerverhiba történt. Próbáld újra.' });
                    }
                }
            }
            return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { error: 'A kért művelet nem támogatott.' });
            return;
        }
        const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
        const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
        if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
            sendJson(response, 403, { error: 'Tiltott fájlútvonal.' });
            return;
        }
        fs.readFile(filePath, (error, contents) => {
            if (error) {
                sendJson(response, 404, { error: 'A kért fájl nem található.' });
                return;
            }
            const extension = path.extname(filePath);
            const contentType = {
                '.html': 'text/html; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8',
                '.svg': 'image/svg+xml',
            }[extension] || 'application/octet-stream';
            response.writeHead(200, {
                'Content-Type': contentType,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-cache',
            });
            response.end(request.method === 'HEAD' ? undefined : contents);
        });
    });
}

if (require.main === module) {
    const server = createServer();
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Blackjack fut: http://localhost:${PORT}`);
    });
}

module.exports = { createDeck, scoreHand, makeRoom, publicState, startRound, createServer };
