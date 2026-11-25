'use strict';

const $ = (selector) => document.querySelector(selector);
const setupScreen = $('#setup-screen');
const tableScreen = $('#table-screen');
const setupError = $('#setup-error');
const tableError = $('#table-error');
const tokenKey = 'pixeljack-token';
const codeKey = 'pixeljack-room';
let roomCode = sessionStorage.getItem(codeKey) || '';
let playerToken = sessionStorage.getItem(tokenKey) || '';
let gameState = null;
let renderedStateSignature = '';
let pendingBet = 2;
let polling = false;
let pollTimer = null;
let demoCards = [];
let demoDrawIndex = 0;

function showError(element, message) {
    element.textContent = message;
    element.hidden = !message;
}

async function request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (playerToken) headers['X-Player-Token'] = playerToken;
    const response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'A kérés sikertelen.');
    return payload;
}

function saveSession(code, token) {
    roomCode = code;
    playerToken = token;
    sessionStorage.setItem(codeKey, code);
    sessionStorage.setItem(tokenKey, token);
}

function clearSession() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    roomCode = '';
    playerToken = '';
    gameState = null;
    sessionStorage.removeItem(codeKey);
    sessionStorage.removeItem(tokenKey);
}

function openTable() {
    setupScreen.hidden = true;
    tableScreen.hidden = false;
    showError(setupError, '');
    if (pollTimer) window.clearInterval(pollTimer);
    refreshState();
    pollTimer = window.setInterval(refreshState, 850);
}

function getName() {
    const name = $('#player-name').value.trim();
    if (!name) throw new Error('Írj be egy becenevet.');
    if (name.length > 20) throw new Error('A becenév legfeljebb 20 karakter lehet.');
    return name;
}

async function createGame(mode) {
    showError(setupError, '');
    try {
        const name = getName();
        const payload = await request('/api/rooms', {
            method: 'POST',
            body: { name, mode, bots: Number($('#bot-count').value) },
        });
        saveSession(payload.code, payload.token);
        gameState = payload.state;
        openTable();
    } catch (error) {
        showError(setupError, error.message);
    }
}

async function joinGame() {
    showError(setupError, '');
    try {
        const name = getName();
        const code = $('#room-code').value.trim().toUpperCase();
        if (!/^[A-Z2-9]{5}$/.test(code)) throw new Error('Adj meg egy 5 karakteres szobakódot.');
        const payload = await request(`/api/rooms/${code}/join`, { method: 'POST', body: { name } });
        saveSession(payload.code, payload.token);
        gameState = payload.state;
        openTable();
    } catch (error) {
        showError(setupError, error.message);
    }
}

async function refreshState() {
    if (!roomCode || !playerToken || polling) return;
    polling = true;
    try {
        const payload = await request(`/api/rooms/${roomCode}/state`);
        gameState = payload.state;
        const signature = JSON.stringify(gameState);
        if (signature !== renderedStateSignature) renderTable();
    } catch (error) {
        showError(tableError, error.message);
        if (error.message.includes('token') || error.message.includes('szoba')) {
            clearSession();
            setupScreen.hidden = false;
            tableScreen.hidden = true;
            showError(setupError, error.message);
        }
    } finally {
        polling = false;
    }
}

async function sendAction(type, extra = {}) {
    showError(tableError, '');
    try {
        const payload = await request(`/api/rooms/${roomCode}/action`, {
            method: 'POST',
            body: { type, ...extra },
        });
        gameState = payload.state;
        renderTable();
    } catch (error) {
        showError(tableError, error.message);
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
}

function renderCard(card, index = 0) {
    if (card.hidden) {
        return '<div class="card back" aria-label="Lefordított lap"><span class="card-suit">♠</span></div>';
    }
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };
    const suitNames = { '♠': 'spades', '♥': 'hearts', '♣': 'clubs', '♦': 'diamonds' };
    const rankIndex = ranks.indexOf(card.rank);
    const suitIndex = suits[card.suit];
    if (rankIndex >= 0 && suitIndex >= 0) {
        return `<div class="card card-face" style="animation-delay:${Math.min(index, 6) * 55}ms;background-image:url('/card-assets/faces/${card.rank}_${suitNames[card.suit]}.png')" role="img" aria-label="${card.rank} ${card.suit}"></div>`;
    }
    const red = card.suit === '♥' || card.suit === '♦' ? ' red' : '';
    return `<div class="card${red}" style="animation-delay:${Math.min(index, 6) * 55}ms" aria-label="${card.rank} ${card.suit}">
        <span class="card-value">${card.rank}</span><span class="card-suit">${card.suit}</span><span class="card-value card-corner">${card.rank}</span>
    </div>`;
}

function renderCards(cards) {
    return cards.length ? cards.map((card, index) => renderCard(card, index)).join('') : '<span class="muted">Még nincs lap</span>';
}

function demoScore() {
    let total = 0;
    let aces = 0;
    for (const card of demoCards) {
        if (card.rank === 'A') {
            total += 11;
            aces += 1;
        } else {
            total += ['K', 'Q', 'J'].includes(card.rank) ? 10 : Number(card.rank);
        }
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }
    return total;
}

function phaseName(phase) {
    return ({
        lobby: 'Szobára várunk',
        betting: 'Tétadás sorban',
        playing: 'Folyamatban a kör',
        dealerTurn: 'Az osztó köre',
        roundEnd: 'Kör vége · jöhet a következő',
        gameOver: 'Játék vége',
    })[phase] || 'Asztal';
}

function renderSeat(player, showCards) {
    const current = player.id === gameState.currentPlayerId ? ' current' : '';
    const eliminated = player.eliminated ? ' eliminated' : '';
    const self = player.id === gameState.viewerId ? ' self' : '';
    const icon = player.isBot ? '♟' : player.isHost ? '♛' : '♙';
    const name = `${escapeHtml(player.name)}${player.id === gameState.viewerId ? ' (te)' : ''}`;
    const hands = player.hands.length
        ? player.hands.map((hand, index) => {
            const active = player.id === gameState.currentPlayerId && index === gameState.currentHandIndex;
            const result = hand.result || (active ? (player.id === gameState.viewerId ? 'Te következel' : 'Következik') : hand.status === 'playing' ? 'Várakozik' : '');
            return `<div class="player-hand${active ? ' current' : ''}">
                <div class="cards">${showCards ? renderCards(hand.cards) : ''}</div>
                <div class="player-meta"><span>${hand.total}${hand.soft ? ' · puha' : ''}</span><span>${hand.bet} zseton</span></div>
                <div class="hand-result">${escapeHtml(result)}</div>
            </div>`;
        }).join('')
        : `<div class="cards"><span class="muted">${player.ready ? 'Készen áll' : 'Tétre vár'}</span></div>`;
    const status = player.eliminated ? 'KIESETT' : player.isBot ? 'ELLENFÉL' :
        player.id === gameState.bettingPlayerId ? 'TÉTET TESZ' : player.ready ? 'TÉT LEADVA' : 'VÁRAKOZIK';
    const betStatus = player.ready ? 'Tét leadva' :
        player.id === gameState.bettingPlayerId ? 'Tétet állít' : 'Vár a sorára';
    return `<article class="player-seat${current}${eliminated}${self}">
        <div class="seat-heading"><span class="avatar">${icon}</span><div><strong>${name}</strong><small>${status}</small></div></div>
        <div class="player-meta"><span>◉ ${player.chips}</span>${!player.hands.length ? `<span>Tét: ${player.bet || '—'}</span>` : ''}</div>
        ${player.hands.length ? hands : `<div class="cards"><span class="muted">${betStatus}</span></div>`}
    </article>`;
}

function viewerCenteredPlayers() {
    const viewerIndex = gameState.players.findIndex((player) => player.id === gameState.viewerId);
    if (viewerIndex < 0) return gameState.players;
    const ordered = [gameState.players[viewerIndex]];
    for (let offset = 1; offset < gameState.players.length; offset += 1) {
        ordered.push(gameState.players[(viewerIndex + offset) % gameState.players.length]);
    }
    return ordered;
}

function renderTable() {
    if (!gameState) return;
    renderedStateSignature = JSON.stringify(gameState);
    showError(tableError, gameState.error || '');
    $('#table-code').textContent = gameState.code;
    $('#table-phase').textContent = phaseName(gameState.phase);
    const showCards = ['playing', 'dealerTurn'].includes(gameState.phase);
    $('#dealer-cards').innerHTML = showCards ? renderCards(gameState.dealer.cards) : '';
    $('#dealer-total').textContent = gameState.phase === 'playing'
        ? `Látható érték: ${gameState.dealer.total}`
        : gameState.phase === 'dealerTurn'
            ? `Összérték: ${gameState.dealer.total}`
        : gameState.phase === 'roundEnd' || gameState.phase === 'gameOver'
            ? `Összérték: ${gameState.dealer.total}`
            : 'Várja a kört';
    const centeredPlayers = viewerCenteredPlayers();
    const seatColumns = [4, 5, 3, 6, 2, 7, 1];
    $('#player-seats').classList.toggle('crowded', centeredPlayers.length > 5);
    $('#player-seats').innerHTML = centeredPlayers.map((player, index) =>
        renderSeat(player, showCards).replace('<article class="', `<article class="seat-position-${seatColumns[index]} `)
    ).join('');
    const viewer = gameState.players.find((player) => player.id === gameState.viewerId);
    const isBettingTurn = viewer && gameState.bettingPlayerId === viewer.id;
    const canBet = ['lobby', 'betting', 'roundEnd'].includes(gameState.phase) && viewer && !viewer.eliminated;
    $('#betting-controls').hidden = !canBet;
    $('#play-controls').hidden = gameState.phase !== 'playing';
    if (canBet) {
        if (pendingBet !== viewer.bet) pendingBet = viewer.bet || gameState.minBet;
        $('#bet-value').textContent = pendingBet;
        $('#bet-minus').disabled = !isBettingTurn || pendingBet <= gameState.minBet;
        $('#bet-plus').disabled = !isBettingTurn || pendingBet + 2 > viewer.chips;
        $('#ready-button').hidden = false;
        $('#ready-button').textContent = viewer.ready ? 'Tét leadva' :
            isBettingTurn ? 'Tét leadása' : 'A te körödre vár';
        $('#ready-button').disabled = !isBettingTurn || viewer.ready ||
            pendingBet < gameState.minBet || pendingBet > viewer.chips;
    }
    const currentPlayer = gameState.players.find((player) => player.id === gameState.currentPlayerId);
    const isMyTurn = gameState.phase === 'playing' && gameState.currentPlayerId === gameState.viewerId;
    const hand = isMyTurn && currentPlayer ? currentPlayer.hands[gameState.currentHandIndex] : null;
    $('#draw-card').disabled = !hand || hand.status !== 'playing';
    $('#stand-action').disabled = !hand || hand.status !== 'playing';
    $('#double-action').disabled = !hand || hand.cards.length !== 2 || viewer.chips < hand.bet ||
        (hand.fromSplit && hand.cards[0].rank === 'A');
    $('#split-action').disabled = !hand || hand.cards.length !== 2 ||
        hand.cards[0].rank !== hand.cards[1].rank || viewer.chips < hand.bet || currentPlayer.hands.length >= 4;
    const results = gameState.lastResults || [];
    if (gameState.phase === 'roundEnd') {
        const nextBetPlayer = gameState.players.find((player) => player.id === gameState.bettingPlayerId);
        const summary = results.map((item) => `${item.playerName}: ${item.result}`).join(' · ');
        const deadline = Number.isInteger(gameState.bettingSecondsRemaining)
            ? ` (${gameState.bettingSecondsRemaining} mp van a tét leadására.)`
            : '';
        $('#round-message').textContent = `${summary || 'A kör lezárult.'}${nextBetPlayer ? ` · Következő tét: ${nextBetPlayer.name}${deadline}` : ''}`;
    } else if (gameState.bettingPlayerId) {
        const bettingPlayer = gameState.players.find((player) => player.id === gameState.bettingPlayerId);
        const isBettingViewer = gameState.bettingPlayerId === gameState.viewerId;
        const deadline = Number.isInteger(gameState.bettingSecondsRemaining)
            ? ` Még ${gameState.bettingSecondsRemaining} mp van hátra; aki nem adja le időben a tétet, kikerül.`
            : '';
        $('#round-message').textContent = isBettingViewer
            ? `Te következel: állítsd be és add le a téted.${deadline}`
            : `${bettingPlayer ? bettingPlayer.name : 'A következő játékos'} teszi a tétet. Várd meg a sorod.${deadline}`;
    } else if (gameState.phase === 'gameOver') {
        $('#round-message').textContent = results.map((item) => `${item.playerName}: ${item.result}`).join(' · ') ||
            (gameState.phase === 'gameOver' ? 'Minden játékos kiesett.' : 'A kör lezárult.');
    } else if (gameState.phase === 'dealerTurn') {
        $('#round-message').textContent = 'Az osztó automatikusan felfedi a lapját, és 17 pontig húz.';
    } else if (gameState.phase === 'playing') {
        $('#round-message').textContent = isMyTurn ? 'Te következel — kattints a paklira, ha lapot kérsz.' :
            currentPlayer ? `${currentPlayer.name} következik.` : 'Az osztó játéka következik.';
    } else {
        $('#round-message').textContent = gameState.phase === 'lobby' && gameState.mode === 'friends'
            ? `${gameState.players.length}/${gameState.maxPlayers} hely foglalt · add át a szobakódot a többieknek. A házigazda kezdi a tétadást.`
            : 'A tétek leadása után a következő játékos kerül sorra; mindenki után a kör automatikusan indul.';
    }
    if (gameState.phase === 'gameOver') {
        $('#betting-controls').hidden = true;
        $('#play-controls').hidden = true;
    }
}

$('#create-solo').addEventListener('click', () => createGame('solo'));
$('#create-room').addEventListener('click', () => createGame('friends'));
$('#join-room').addEventListener('click', joinGame);
$('#room-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinGame();
});
$('#room-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
});
$('#bet-minus').addEventListener('click', async () => {
    if (!gameState) return;
    pendingBet = Math.max(gameState.minBet, pendingBet - 2);
    await sendAction('bet', { amount: pendingBet });
});
$('#bet-plus').addEventListener('click', async () => {
    const viewer = gameState?.players.find((player) => player.id === gameState.viewerId);
    if (!viewer) return;
    pendingBet = Math.min(viewer.chips - (viewer.chips % 2), pendingBet + 2);
    await sendAction('bet', { amount: pendingBet });
});
$('#ready-button').addEventListener('click', () => sendAction('ready'));
$('#draw-card').addEventListener('click', () => sendAction('hit'));
$('#stand-action').addEventListener('click', () => sendAction('stand'));
$('#double-action').addEventListener('click', () => sendAction('double'));
$('#split-action').addEventListener('click', () => sendAction('split'));
$('#copy-code').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(roomCode);
        $('#copy-code').textContent = 'Kimásolva!';
        window.setTimeout(() => { $('#copy-code').textContent = 'Kód másolása'; }, 1400);
    } catch {
        showError(tableError, 'A vágólap nem érhető el; a kódot kézzel is megoszthatod.');
    }
});
$('#leave-table').addEventListener('click', async () => {
    try {
        await request(`/api/rooms/${roomCode}/leave`, { method: 'POST', body: {} });
    } catch (error) {
        showError(tableError, error.message);
    } finally {
        clearSession();
        setupScreen.hidden = false;
        tableScreen.hidden = true;
    }
});

function openTutorial() {
    $('#tutorial-copy').innerHTML = `
        <p>Az ász 1 vagy 11, a figurák 10-et érnek. A cél 21-hez minél közelebb jutni anélkül, hogy túllépnéd.</p>
        <p>A téteket a házigazdától kezdve, csatlakozási sorrendben adjátok le. Lapot a paklira kattintva húzol; a megállás lezárja a kezed.</p>
        <p>A kezdő két lap után duplázhatsz vagy azonos rangú párt oszthatsz. Az osztó 17-től megáll. A blackjack 3:2-t fizet.</p>
        <p>Minden körben új, megkevert, jokerek nélküli 52 lapos pakli indul. Valódi pénzt nem használunk.</p>`;
    $('#tutorial-demo').hidden = true;
    $('#tutorial-copy').hidden = false;
    $('#tutorial-next').textContent = 'Próbajáték';
    $('#tutorial-dialog').showModal();
}

function beginDemo() {
    demoCards = [{ rank: '10', suit: '♠' }, { rank: '6', suit: '♥' }];
    demoDrawIndex = 0;
    $('#demo-player-cards').innerHTML = renderCards(demoCards);
    $('#demo-dealer-cards').innerHTML = renderCards([{ rank: 'Q', suit: '♦' }, { hidden: true }]);
    $('#demo-message').textContent = '16 pontod van. Húzhatsz egy lapot, vagy megállhatsz.';
    $('#demo-hit').disabled = false;
    $('#demo-stand').disabled = false;
    $('#tutorial-copy').hidden = true;
    $('#tutorial-demo').hidden = false;
    $('#tutorial-next').textContent = 'Belépés a játékba';
}

$('#tutorial-next').addEventListener('click', () => {
    if ($('#tutorial-demo').hidden) beginDemo();
    else $('#tutorial-dialog').close();
});
$('#demo-hit').addEventListener('click', () => {
    const tutorialDeck = [
        { rank: '4', suit: '♣' }, { rank: 'A', suit: '♦' }, { rank: '8', suit: '♥' },
    ];
    if (demoDrawIndex >= tutorialDeck.length) return;
    demoCards.push(tutorialDeck[demoDrawIndex]);
    demoDrawIndex += 1;
    const total = demoScore();
    $('#demo-player-cards').innerHTML = renderCards(demoCards);
    if (total > 21) {
        $('#demo-message').textContent = 'Túllépted a 21-et — ez a kéz vesztett. Próbálj új kört!';
        $('#demo-hit').disabled = true;
        $('#demo-stand').disabled = true;
    } else {
        $('#demo-message').textContent = `${total} pontod van. Húzhatsz még, vagy megállhatsz.`;
    }
});
$('#demo-stand').addEventListener('click', () => {
    $('#demo-dealer-cards').innerHTML = renderCards([{ rank: 'Q', suit: '♦' }, { rank: '7', suit: '♠' }]);
    const values = demoScore();
    const result = values > 21 ? 'vesztettél' : values > 17 ? 'nyertél' : values === 17 ? 'döntetlen' : 'az osztó nyert';
    $('#demo-message').textContent = `Az osztó 17-et mutat. ${values} ponttal ${result}. A gyakorlókör kész!`;
    $('#demo-hit').disabled = true;
    $('#demo-stand').disabled = true;
});
$('#open-tutorial').addEventListener('click', openTutorial);
document.querySelectorAll('.close-tutorial').forEach((button) => {
    button.addEventListener('click', () => $('#tutorial-dialog').close());
});
$('#tutorial-dialog').addEventListener('close', () => {
    try { localStorage.setItem('pixeljack-tutorial-seen', 'yes'); } catch { /* Local storage may be disabled. */ }
});

if (roomCode && playerToken) {
    openTable();
} else {
    setupScreen.hidden = false;
    tableScreen.hidden = true;
    try {
        if (!localStorage.getItem('pixeljack-tutorial-seen')) openTutorial();
    } catch {
        openTutorial();
    }
}
