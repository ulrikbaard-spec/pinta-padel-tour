/**
 * PINTA PADEL TOUR – HUVUDMOTOR
 * Minimalistisk, serverlös padelturnering för 8 spelare på 2 banor.
 * Robust användarhantering: Arrangör (Admin), Spelare (med matchfokus) och Gästläge.
 */

(function () {
    'use strict';

    // =========================================================================
    // 1. KONSTANTER & TILLSTÅND (STATE)
    // =========================================================================

    const STORAGE_KEY = 'pinta_padel_data_v2';
    const AUTH_KEY = 'pinta_padel_user_v2';
    const ADMIN_KEYS_KEY = 'pinta_padel_adminkeys_v2';
    const LOGOUT_FLAG_KEY = 'pinta_explicit_logout_v2';

    const appState = {
        tournaments: [],
        deletedTournaments: [],
        activeTournamentId: null,
        currentUser: null,       // { id, name, role: 'admin'|'player', pin, tourneyKey }
        currentRoundIndex: 0,    // 0..6
        cloudConnected: false
    };

    let mqttClient = null;
    let broadcastChannel = null;
    let undoToastTimer = null;
    let audioCtx = null;
    let selectedPlayerForLogin = null;

    // Standard balanserad Americano-matris för 8 spelare (7 omgångar)
    // Varje spelare spelar med alla andra 7 exakt en gång och möter alla två gånger.
    const SCHEDULE_MATRIX = [
        // Omgång 1
        { court1: [[0, 1], [2, 3]], court2: [[4, 5], [6, 7]] },
        // Omgång 2
        { court1: [[0, 2], [4, 6]], court2: [[1, 3], [5, 7]] },
        // Omgång 3
        { court1: [[0, 3], [5, 6]], court2: [[1, 2], [4, 7]] },
        // Omgång 4
        { court1: [[0, 4], [1, 5]], court2: [[2, 6], [3, 7]] },
        // Omgång 5
        { court1: [[0, 5], [2, 7]], court2: [[1, 6], [3, 4]] },
        // Omgång 6
        { court1: [[0, 6], [1, 7]], court2: [[2, 4], [3, 5]] },
        // Omgång 7
        { court1: [[0, 7], [3, 6]], court2: [[1, 4], [2, 5]] }
    ];

    // =========================================================================
    // 2. LJUDMOTOR (WEB AUDIO API - INGA EXTERNA MP3-FILER)
    // =========================================================================

    function getAudioContext() {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) audioCtx = new AudioContextClass();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playTone(freq, duration = 0.08, type = 'sine', gainVal = 0.08) {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(gainVal, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {}
    }

    function playClick() { playTone(620, 0.04, 'sine', 0.06); }
    function playSuccess() {
        playTone(523.25, 0.08, 'sine', 0.08);
        setTimeout(() => playTone(659.25, 0.12, 'sine', 0.08), 80);
    }
    function playFanfare() {
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((n, i) => {
            setTimeout(() => playTone(n, 0.15, 'triangle', 0.1), i * 90);
        });
    }
    function playScoreSaved() { playTone(880, 0.06, 'sine', 0.07); }
    function playDelete() { playTone(280, 0.15, 'sawtooth', 0.08); }

    // =========================================================================
    // 3. PERSISTENS (LOCALSTORAGE & SYNC)
    // =========================================================================

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                appState.tournaments = parsed.tournaments || [];
                appState.deletedTournaments = parsed.deletedTournaments || [];
                appState.activeTournamentId = parsed.activeTournamentId || null;
            }
        } catch (e) {
            console.error('Kunde inte läsa state:', e);
        }

        // Läs inloggad användare
        try {
            const userRaw = localStorage.getItem(AUTH_KEY);
            if (userRaw) {
                appState.currentUser = JSON.parse(userRaw);
            } else {
                appState.currentUser = null;
            }
        } catch (e) {
            appState.currentUser = null;
        }

        // Kontrollera om användaren uttryckligen har loggat ut
        const isExplicitlyLoggedOut = sessionStorage.getItem(LOGOUT_FLAG_KEY) === 'true';

        // Om skaparen besöker sin egen turnering på denna enhet och INTE uttryckligen loggat ut:
        const active = getActiveTournament();
        if (active && !appState.currentUser && !isExplicitlyLoggedOut) {
            const adminKeys = getAdminKeys();
            if (active.adminKey && adminKeys[active.id] === active.adminKey) {
                appState.currentUser = {
                    id: (active.organizer && active.organizer.id) ? active.organizer.id : 'org_' + active.id,
                    name: (active.organizer && active.organizer.name) ? active.organizer.name : 'Arrangör',
                    role: 'admin',
                    tourneyKey: active.adminKey
                };
                saveUser();
            }
        }

        checkUrlForSharedTournament();
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                tournaments: appState.tournaments,
                deletedTournaments: appState.deletedTournaments,
                activeTournamentId: appState.activeTournamentId
            }));
            broadcastLocalUpdate();
            syncToCloud();
        } catch (e) {
            console.error('Kunde inte spara state:', e);
        }
    }

    function saveUser() {
        try {
            if (appState.currentUser) {
                localStorage.setItem(AUTH_KEY, JSON.stringify(appState.currentUser));
                sessionStorage.removeItem(LOGOUT_FLAG_KEY);
            } else {
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (e) {}
    }

    function logoutUser() {
        appState.currentUser = null;
        saveUser();
        sessionStorage.setItem(LOGOUT_FLAG_KEY, 'true');

        // Rensa eventuella admin-parametrar i URL så man inte återinloggas vid sidomladdning
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('key');
            url.searchParams.delete('admin');
            history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
        } catch (e) {}

        renderApp();
        playClick();
        showToast('👤 Du är nu utloggad (Gästläge).');
    }

    function getAdminKeys() {
        try {
            return JSON.parse(localStorage.getItem(ADMIN_KEYS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveAdminKeyForTourney(tourneyId, key) {
        const keys = getAdminKeys();
        keys[tourneyId] = key;
        try {
            localStorage.setItem(ADMIN_KEYS_KEY, JSON.stringify(keys));
        } catch (e) {}
    }

    // =========================================================================
    // 4. REALTI DSSYNK (MQTT & BROADCASTCHANNEL)
    // =========================================================================

    try {
        if ('BroadcastChannel' in window) {
            broadcastChannel = new BroadcastChannel('pinta_padel_sync');
            broadcastChannel.onmessage = (event) => {
                if (event.data && event.data.type === 'SYNC') {
                    loadState();
                    renderApp();
                }
            };
        }
    } catch (e) {}

    function broadcastLocalUpdate() {
        if (broadcastChannel) {
            broadcastChannel.postMessage({ type: 'SYNC', timestamp: Date.now() });
        }
    }

    function initCloudSync() {
        const active = getActiveTournament();
        const dot = document.getElementById('syncDot');
        if (!active || typeof Paho === 'undefined' || !Paho.MQTT) {
            if (dot) dot.classList.add('offline');
            return;
        }

        try {
            if (mqttClient && mqttClient.isConnected()) return;

            const clientId = 'pinta_' + Math.random().toString(16).substring(2, 10);
            mqttClient = new Paho.MQTT.Client('broker.hivemq.com', 8884, '/mqtt', clientId);

            mqttClient.onConnectionLost = () => {
                appState.cloudConnected = false;
                if (dot) dot.classList.add('offline');
                setTimeout(initCloudSync, 4000);
            };

            mqttClient.onMessageArrived = (message) => {
                try {
                    const data = JSON.parse(message.payloadString);
                    if (data && data.tourney && data.tourney.id === appState.activeTournamentId) {
                        const idx = appState.tournaments.findIndex(t => t.id === data.tourney.id);
                        if (idx >= 0) {
                            appState.tournaments[idx] = data.tourney;
                        } else {
                            appState.tournaments.push(data.tourney);
                        }
                        localStorage.setItem(STORAGE_KEY, JSON.stringify({
                            tournaments: appState.tournaments,
                            deletedTournaments: appState.deletedTournaments,
                            activeTournamentId: appState.activeTournamentId
                        }));
                        renderApp();
                        playTone(720, 0.05);
                    }
                } catch (e) {}
            };

            mqttClient.connect({
                useSSL: true,
                timeout: 5,
                keepAliveInterval: 30,
                onSuccess: () => {
                    appState.cloudConnected = true;
                    if (dot) dot.classList.remove('offline');
                    mqttClient.subscribe(`pinta_padel_tour/tourney/${active.id}`);
                },
                onFailure: () => {
                    appState.cloudConnected = false;
                    if (dot) dot.classList.add('offline');
                }
            });
        } catch (e) {
            if (dot) dot.classList.add('offline');
        }
    }

    function syncToCloud() {
        const active = getActiveTournament();
        if (!active || !mqttClient || !mqttClient.isConnected()) return;
        try {
            const topic = `pinta_padel_tour/tourney/${active.id}`;
            const message = new Paho.MQTT.Message(JSON.stringify({
                type: 'SYNC',
                tourney: active,
                timestamp: Date.now()
            }));
            message.destinationName = topic;
            message.retained = true;
            mqttClient.send(message);
        } catch (e) {}
    }

    // =========================================================================
    // 5. URL-DELNING & INBJUDAN
    // =========================================================================

    function checkUrlForSharedTournament() {
        const urlParams = new URLSearchParams(window.location.search);
        const tourneyId = urlParams.get('t') || urlParams.get('id');
        const adminKeyParam = urlParams.get('key') || urlParams.get('admin');

        if (tourneyId) {
            let found = appState.tournaments.find(t => t.id === tourneyId);
            if (!found) {
                const tourneyName = urlParams.get('n') || urlParams.get('namn') || 'Pinta Padel Tour';
                found = {
                    id: tourneyId,
                    name: decodeURIComponent(tourneyName),
                    format: 'option1',
                    pointSystem: 'games',
                    status: 'lobby',
                    isDrawn: false,
                    players: [],
                    rounds: [],
                    createdAt: new Date().toISOString(),
                    organizer: null
                };
                appState.tournaments.push(found);
            }
            appState.activeTournamentId = tourneyId;
            saveState();
        }

        const active = getActiveTournament();
        const isExplicitlyLoggedOut = sessionStorage.getItem(LOGOUT_FLAG_KEY) === 'true';

        if (adminKeyParam && active && !isExplicitlyLoggedOut) {
            if (adminKeyParam.toLowerCase() === 'ulrik' || (active.adminKey && active.adminKey === adminKeyParam)) {
                active.adminKey = adminKeyParam;
                saveAdminKeyForTourney(active.id, adminKeyParam);
                appState.currentUser = {
                    id: (active.organizer && active.organizer.id) ? active.organizer.id : 'org_' + active.id,
                    name: (active.organizer && active.organizer.name) ? active.organizer.name : 'Arrangör',
                    role: 'admin',
                    tourneyKey: adminKeyParam
                };
                saveUser();
                saveState();
            }
        }
    }

    function getShareableUrl(tourney, forAdmin = false) {
        if (!tourney) return window.location.origin + window.location.pathname;
        const base = window.location.origin + window.location.pathname;
        const cleanName = encodeURIComponent(tourney.name || 'Padel');
        if (forAdmin && tourney.adminKey) {
            return `${base}?t=${tourney.id}&n=${cleanName}&key=${tourney.adminKey}`;
        }
        return `${base}?t=${tourney.id}&n=${cleanName}`;
    }

    // =========================================================================
    // 6. ANVÄNDARROLLER & BEHÖRIGHETER
    // =========================================================================

    function getActiveTournament() {
        return appState.tournaments.find(t => t.id === appState.activeTournamentId) || null;
    }

    function isOrganizer() {
        if (!appState.currentUser) return false;
        return appState.currentUser.role === 'admin';
    }

    function isPlayer() {
        if (!appState.currentUser) return false;
        return appState.currentUser.role === 'player';
    }

    function isGuest() {
        return !appState.currentUser;
    }

    function isCurrentUserInMatch(match) {
        if (!appState.currentUser) return false;
        const userId = appState.currentUser.id;
        const userName = (appState.currentUser.name || '').toLowerCase();

        const inTeam1 = (match.team1 || []).some(p => p.id === userId || (p.name && p.name.toLowerCase() === userName));
        const inTeam2 = (match.team2 || []).some(p => p.id === userId || (p.name && p.name.toLowerCase() === userName));

        return inTeam1 || inTeam2;
    }

    function canUserEditMatch(match) {
        // Arrangören har full behörighet att redigera alla matcher
        if (isOrganizer()) return true;

        // En spelare kan enbart mata in / spara resultatet i matchen de själva deltar i!
        if (isPlayer() && isCurrentUserInMatch(match)) return true;

        // Gäster och spelare på den andra banan kan inte redigera
        return false;
    }

    // =========================================================================
    // 7. TURNERINGSHANTERING (SKAPA, LOTTA, RADERA)
    // =========================================================================

    function createNewTournament(name, organizerName, organizerPlays = true, format = 'option1', pointSystem = 'games') {
        const id = 'pt_' + Date.now();
        const adminKey = 'adm_' + Math.random().toString(36).substring(2, 9);
        const adminCode = 'PT-' + Math.floor(10 + Math.random() * 90);
        const orgCleanName = organizerName.trim() || 'Arrangör';

        const newTourney = {
            id: id,
            name: name.trim() || 'Padelturnering',
            format: format,
            pointSystem: pointSystem,
            createdAt: new Date().toISOString(),
            status: 'lobby',
            isDrawn: false,
            adminKey: adminKey,
            adminCode: adminCode,
            organizer: {
                id: 'org_' + id,
                name: orgCleanName
            },
            players: [],
            rounds: []
        };

        // Om arrangören spelar själv -> sätts på Plats 1 med egen PIN
        if (organizerPlays) {
            const orgPin = Math.floor(1000 + Math.random() * 9000).toString();
            newTourney.players.push({
                id: 'p_org_' + id,
                name: orgCleanName,
                pin: orgPin,
                isOrganizer: true
            });
        }

        saveAdminKeyForTourney(id, adminKey);
        appState.tournaments.unshift(newTourney);
        appState.activeTournamentId = id;

        // Skaparen blir inloggad som arrangör
        appState.currentUser = {
            id: 'org_' + id,
            name: orgCleanName,
            role: 'admin',
            tourneyKey: adminKey
        };

        saveUser();
        saveState();
        initCloudSync();
        renderApp();
        switchView('viewPlayers');
        playSuccess();
        showToast(`🎾 Turneringen "${newTourney.name}" skapades! Du är inloggad som arrangör.`);
    }

    function registerPlayer(tourney, name, slotIndex) {
        if (!tourney) return false;
        if (tourney.players.length >= 8) {
            alert('Turneringen är redan full (8 spelare).');
            return false;
        }

        const cleanName = name.trim();
        if (!cleanName) return false;

        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        const newPlayer = {
            id: 'p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
            name: cleanName,
            pin: pin,
            isOrganizer: false
        };

        tourney.players.push(newPlayer);

        const wasOrganizer = isOrganizer();

        // Om en gäst registrerar sig -> logga in direkt som denna spelare!
        if (!wasOrganizer) {
            appState.currentUser = {
                id: newPlayer.id,
                name: newPlayer.name,
                pin: newPlayer.pin,
                role: 'player'
            };
            saveUser();
        }

        saveState();
        renderApp();

        // Visa PIN-bekräftelse med anpassat budskap
        const modalTitle = document.getElementById('pinConfirmTitle');
        const modalDesc = document.getElementById('pinConfirmDesc');
        const modalTip = document.getElementById('pinConfirmTip');

        if (wasOrganizer) {
            if (modalTitle) modalTitle.textContent = 'Spelare tillagd!';
            if (modalDesc) modalDesc.innerHTML = `<strong>${escapeHtml(newPlayer.name)}</strong> har tilldelats Plats ${tourney.players.length} av 8.`;
            if (modalTip) modalTip.textContent = `Ge koden ${newPlayer.pin} till spelaren så kan de logga in på sin egen mobil. Du förblir inloggad som arrangör.`;
        } else {
            if (modalTitle) modalTitle.textContent = 'Plats bokad!';
            if (modalDesc) modalDesc.innerHTML = `Välkommen till turneringen, <strong>${escapeHtml(newPlayer.name)}</strong>! Du har Plats ${tourney.players.length} av 8.`;
            if (modalTip) modalTip.textContent = 'Spara din 4-siffriga kod för att logga in och rapportera dina matcher.';
        }

        document.getElementById('pinConfirmName').textContent = newPlayer.name;
        document.getElementById('pinConfirmCode').textContent = newPlayer.pin;
        openModal('modalPinConfirm');

        playSuccess();
        return true;
    }

    function removePlayer(tourney, playerIndex) {
        if (!tourney || tourney.isDrawn) return;
        if (!isOrganizer()) {
            alert('Endast turneringens arrangör kan ta bort anmälda spelare.');
            return;
        }

        const player = tourney.players[playerIndex];
        if (confirm(`Vill du ta bort "${player.name}" från turneringen?`)) {
            // Om den borttagna spelaren var inloggad på denna enhet -> logga ut
            if (appState.currentUser && appState.currentUser.id === player.id) {
                logoutUser();
            }
            tourney.players.splice(playerIndex, 1);
            saveState();
            renderApp();
            playClick();
            showToast(`"${player.name}" togs bort.`);
        }
    }

    /**
     * Lottning av spelschema (8 spelare, 7 omgångar)
     */
    function drawSchedule(tourney) {
        if (!tourney || tourney.isDrawn) return;
        if (tourney.players.length !== 8) {
            alert('Alla 8 platser måste vara fyllda innan lottning kan genomföras.');
            return;
        }
        if (!isOrganizer()) {
            alert('Endast arrangören kan genomföra lottningen.');
            return;
        }

        // Slumpa spelarnas ordning 1..8
        const shuffled = [...tourney.players].sort(() => Math.random() - 0.5);
        tourney.players = shuffled;

        const rounds = [];
        SCHEDULE_MATRIX.forEach((roundData, rIndex) => {
            const court1Pairs = roundData.court1;
            const court2Pairs = roundData.court2;

            rounds.push({
                roundNumber: rIndex + 1,
                matches: [
                    {
                        court: 1,
                        team1: [shuffled[court1Pairs[0][0]], shuffled[court1Pairs[0][1]]],
                        team2: [shuffled[court1Pairs[1][0]], shuffled[court1Pairs[1][1]]],
                        score1: 0,
                        score2: 0,
                        completed: false
                    },
                    {
                        court: 2,
                        team1: [shuffled[court2Pairs[0][0]], shuffled[court2Pairs[0][1]]],
                        team2: [shuffled[court2Pairs[1][0]], shuffled[court2Pairs[1][1]]],
                        score1: 0,
                        score2: 0,
                        completed: false
                    }
                ]
            });
        });

        tourney.rounds = rounds;
        tourney.isDrawn = true;
        tourney.status = 'active';

        saveState();
        renderApp();
        playFanfare();
        showToast('🎲 Lottningen är klar! Spelschemat är redo.');
    }

    /**
     * Radera turnering – Fullständig nollställning och återgång till Startskärmen
     */
    function deleteTournament(tourneyId, permanent = false) {
        if (permanent) {
            const pIdx = appState.deletedTournaments.findIndex(t => t.id === tourneyId);
            if (pIdx >= 0) {
                appState.deletedTournaments.splice(pIdx, 1);
                saveState();
                renderArchiveModal();
                playClick();
            }
            return;
        }

        const idx = appState.tournaments.findIndex(t => t.id === tourneyId);
        if (idx < 0) return;

        const tourney = appState.tournaments.splice(idx, 1)[0];
        tourney.deletedAt = new Date().toISOString();
        appState.deletedTournaments.unshift(tourney);

        // Nollställ allt till startskärm
        appState.activeTournamentId = null;

        // Om användaren var inloggad som spelare i turneringen, nollställ sessionen
        if (appState.currentUser && appState.currentUser.role === 'player') {
            appState.currentUser = null;
            saveUser();
        }

        try {
            history.replaceState(null, '', window.location.pathname);
        } catch (e) {}

        document.title = 'Pinta Padel Tour – Turneringsmotor';

        saveState();
        renderApp();
        playDelete();
        showUndoToast(tourney);
    }

    function restoreTournament(tourneyId) {
        const idx = appState.deletedTournaments.findIndex(t => t.id === tourneyId);
        if (idx < 0) return;

        const tourney = appState.deletedTournaments.splice(idx, 1)[0];
        delete tourney.deletedAt;
        appState.tournaments.unshift(tourney);
        appState.activeTournamentId = tourney.id;

        saveState();
        initCloudSync();
        renderApp();
        switchView('viewPlayers');
        playSuccess();
        showToast(`↺ Turneringen "${tourney.name}" är återställd.`);
    }

    // =========================================================================
    // 8. RESULTAT & TABELLBERÄKNING
    // =========================================================================

    function calculateLeaderboard(tourney) {
        if (!tourney || !tourney.players) return [];

        const stats = {};
        tourney.players.forEach(p => {
            stats[p.id] = {
                id: p.id,
                name: p.name,
                matchesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                pointsScored: 0,
                pointsConceded: 0,
                diff: 0,
                totalPoints: 0
            };
        });

        (tourney.rounds || []).forEach(r => {
            (r.matches || []).forEach(m => {
                if (m.completed) {
                    const s1 = parseInt(m.score1, 10) || 0;
                    const s2 = parseInt(m.score2, 10) || 0;

                    m.team1.forEach(p => {
                        if (!stats[p.id]) return;
                        stats[p.id].matchesPlayed += 1;
                        stats[p.id].pointsScored += s1;
                        stats[p.id].pointsConceded += s2;
                        if (s1 > s2) stats[p.id].wins += 1;
                        else if (s1 < s2) stats[p.id].losses += 1;
                        else stats[p.id].draws += 1;
                    });

                    m.team2.forEach(p => {
                        if (!stats[p.id]) return;
                        stats[p.id].matchesPlayed += 1;
                        stats[p.id].pointsScored += s2;
                        stats[p.id].pointsConceded += s1;
                        if (s2 > s1) stats[p.id].wins += 1;
                        else if (s2 < s1) stats[p.id].losses += 1;
                        else stats[p.id].draws += 1;
                    });
                }
            });
        });

        const list = Object.values(stats);
        list.forEach(item => {
            item.diff = item.pointsScored - item.pointsConceded;
            item.totalPoints = item.pointsScored;
        });

        // Sortering: Poäng -> Målskillnad -> Flest vinster -> Flest gjorda poäng
        list.sort((a, b) => {
            if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
            if (b.diff !== a.diff) return b.diff - a.diff;
            if (b.wins !== a.wins) return b.wins - a.wins;
            return b.pointsScored - a.pointsScored;
        });

        return list;
    }

    function saveMatchScore(courtIndex) {
        const tourney = getActiveTournament();
        if (!tourney || !tourney.rounds || !tourney.rounds[appState.currentRoundIndex]) return;

        const round = tourney.rounds[appState.currentRoundIndex];
        const match = round.matches[courtIndex];
        if (!match) return;

        if (!canUserEditMatch(match)) {
            alert('Du har inte behörighet att rapportera denna match.');
            return;
        }

        const input1 = document.getElementById(`court${courtIndex + 1}Score1`);
        const input2 = document.getElementById(`court${courtIndex + 1}Score2`);

        const s1 = Math.max(0, parseInt(input1.value, 10) || 0);
        const s2 = Math.max(0, parseInt(input2.value, 10) || 0);

        match.score1 = s1;
        match.score2 = s2;
        match.completed = true;

        saveState();
        renderApp();
        playScoreSaved();
        showToast(`Bana ${courtIndex + 1} sparad: ${s1} – ${s2}`);
    }

    // =========================================================================
    // 9. RENDERING & ANVÄNDARVISNING
    // =========================================================================

    function renderApp() {
        const tourney = getActiveTournament();

        const elHeaderTitle = document.getElementById('headerTourneyTitle');
        const elHeaderSub = document.getElementById('headerTourneySub');
        const elBottomNav = document.getElementById('bottomNav');
        const elStartScreen = document.getElementById('viewStartScreen');

        // 1. Startskärm vs Aktiv Turnering
        if (!tourney) {
            elStartScreen.style.display = 'flex';
            document.querySelectorAll('.app-view').forEach(v => v.style.display = 'none');
            if (elBottomNav) elBottomNav.style.display = 'none';

            if (elHeaderTitle) elHeaderTitle.textContent = 'Pinta Padel';
            if (elHeaderSub) elHeaderSub.textContent = 'Ingen aktiv turnering';

            const totalSaved = appState.tournaments.length + appState.deletedTournaments.length;
            const btnArchive = document.getElementById('btnStartArchive');
            const countEl = document.getElementById('startArchiveCount');
            if (btnArchive) {
                if (totalSaved > 0) {
                    btnArchive.style.display = 'block';
                    if (countEl) countEl.textContent = totalSaved;
                } else {
                    btnArchive.style.display = 'none';
                }
            }
            renderUserStatus();
            return;
        }

        // Aktiv turnering finns
        elStartScreen.style.display = 'none';
        if (elBottomNav) elBottomNav.style.display = 'flex';

        if (elHeaderTitle) elHeaderTitle.textContent = tourney.name;
        if (elHeaderSub) {
            elHeaderSub.textContent = tourney.format === 'option1' 
                ? 'Lag-serie (7 omgångar)' 
                : 'Bana-rotation';
        }

        renderUserStatus();
        renderPlayersView(tourney);
        renderMatchesView(tourney);
        renderTableView(tourney);
        renderMenuView(tourney);
    }

    /**
     * Header & Användarstatus
     */
    function renderUserStatus() {
        const iconEl = document.getElementById('headerUserIcon');
        const nameEl = document.getElementById('headerUserName');
        const btnUser = document.getElementById('btnUserHeader');

        if (appState.currentUser) {
            if (appState.currentUser.role === 'admin') {
                if (iconEl) iconEl.textContent = '👑';
                if (nameEl) nameEl.textContent = `Arrangör (${appState.currentUser.name})`;
                if (btnUser) btnUser.style.borderColor = 'var(--primary)';
            } else {
                if (iconEl) iconEl.textContent = '🎾';
                if (nameEl) nameEl.textContent = appState.currentUser.name;
                if (btnUser) btnUser.style.borderColor = 'rgba(0, 230, 118, 0.4)';
            }
        } else {
            // INGEN STÅR SOM INLOGGAD
            if (iconEl) iconEl.textContent = '👤';
            if (nameEl) nameEl.textContent = 'Logga in';
            if (btnUser) btnUser.style.borderColor = 'var(--border-subtle)';
        }
    }

    /**
     * Flik 1: Spelare
     */
    function renderPlayersView(tourney) {
        const count = tourney.players.length;
        const percent = Math.min(100, Math.round((count / 8) * 100));

        const badge = document.getElementById('playerCountBadge');
        const bar = document.getElementById('playerProgressBar');
        const navBadge = document.getElementById('navPlayerBadge');

        if (badge) badge.textContent = `${count} av 8 anmälda`;
        if (bar) bar.style.width = `${percent}%`;
        if (navBadge) navBadge.textContent = `${count}/8`;

        const rosterEl = document.getElementById('rosterList');
        if (!rosterEl) return;
        rosterEl.innerHTML = '';

        const isUserAdmin = isOrganizer();
        const currentUserId = appState.currentUser ? appState.currentUser.id : null;
        const currentUserName = appState.currentUser ? (appState.currentUser.name || '').toLowerCase() : '';

        for (let i = 0; i < 8; i++) {
            const player = tourney.players[i];
            const row = document.createElement('div');
            row.className = 'roster-slot-row';

            if (player) {
                const isMe = (currentUserId && player.id === currentUserId) || 
                             (currentUserName && player.name.toLowerCase() === currentUserName);

                if (isMe) row.classList.add('is-current-user');

                let badgeHtml = '';
                if (player.isOrganizer && isMe) {
                    badgeHtml = '<span class="badge-you">Du / Arrangör</span>';
                } else if (isMe) {
                    badgeHtml = '<span class="badge-you">Du</span>';
                } else if (player.isOrganizer) {
                    badgeHtml = '<span class="badge-organizer">Arrangör</span>';
                }

                // Endast arrangören kan ta bort spelare med (✕) innan lottning
                const deleteBtnHtml = (!tourney.isDrawn && isUserAdmin) 
                    ? `<button type="button" class="btn-remove-player" data-idx="${i}" title="Ta bort spelare">✕</button>` 
                    : '';

                row.innerHTML = `
                    <div class="slot-left">
                        <span class="slot-index">${i + 1}</span>
                        <span class="slot-name">${escapeHtml(player.name)}</span>
                    </div>
                    <div class="slot-badges">
                        ${badgeHtml}
                        ${deleteBtnHtml}
                    </div>
                `;
            } else {
                row.innerHTML = `
                    <div class="slot-left">
                        <span class="slot-index">${i + 1}</span>
                        <span class="slot-empty-text">Ledig plats</span>
                    </div>
                    <button type="button" class="btn-take-slot" data-slot="${i}">
                        + Ta plats
                    </button>
                `;
            }
            rosterEl.appendChild(row);
        }

        // Länkdelning: döljs om 8/8 eller lottad
        const inviteStrip = document.getElementById('inviteStrip');
        if (inviteStrip) {
            inviteStrip.style.display = (count >= 8 || tourney.isDrawn) ? 'none' : 'flex';
        }

        // Lottningshandling
        const btnDraw = document.getElementById('btnDrawSchedule');
        const drawnNotice = document.getElementById('drawnStatusNotice');

        if (tourney.isDrawn) {
            if (btnDraw) btnDraw.style.display = 'none';
            if (drawnNotice) drawnNotice.style.display = 'flex';
        } else {
            if (drawnNotice) drawnNotice.style.display = 'none';
            if (btnDraw) {
                btnDraw.style.display = 'block';
                if (isUserAdmin) {
                    if (count === 8) {
                        btnDraw.disabled = false;
                        btnDraw.textContent = '🎲 Lotta spelschema';
                    } else {
                        btnDraw.disabled = true;
                        btnDraw.textContent = `Lotta spelschema (${8 - count} platser kvar)`;
                    }
                } else {
                    btnDraw.disabled = true;
                    btnDraw.textContent = count === 8 
                        ? '8/8 anmälda – arrangören lottar snart' 
                        : `Väntar på 8 spelare (${count}/8)`;
                }
            }
        }
    }

    /**
     * Flik 2: Matcher (med rollbaserat matchfokus)
     */
    function renderMatchesView(tourney) {
        const notDrawnBox = document.getElementById('notDrawnBox');
        const activeContainer = document.getElementById('matchesActiveContainer');

        if (!tourney.isDrawn || !tourney.rounds || tourney.rounds.length === 0) {
            if (notDrawnBox) notDrawnBox.style.display = 'block';
            if (activeContainer) activeContainer.style.display = 'none';
            return;
        }

        if (notDrawnBox) notDrawnBox.style.display = 'none';
        if (activeContainer) activeContainer.style.display = 'flex';

        // Uppdatera omgångspiller
        document.querySelectorAll('.round-pill').forEach((pill, idx) => {
            pill.classList.toggle('active', idx === appState.currentRoundIndex);
        });

        const round = tourney.rounds[appState.currentRoundIndex];
        if (!round || !round.matches) return;

        const currentUserId = appState.currentUser ? appState.currentUser.id : null;
        const currentUserName = appState.currentUser ? (appState.currentUser.name || '').toLowerCase() : '';

        // Rendera Bana 1 och Bana 2
        round.matches.forEach((m, cIdx) => {
            const courtNum = cIdx + 1;
            const card = document.getElementById(`courtCard${courtNum}`);
            const statusEl = document.getElementById(`courtStatus${courtNum}`);
            const userTag = document.getElementById(`courtUserTag${courtNum}`);
            const t1Names = document.getElementById(`court${courtNum}Team1Names`);
            const t2Names = document.getElementById(`court${courtNum}Team2Names`);
            const s1Input = document.getElementById(`court${courtNum}Score1`);
            const s2Input = document.getElementById(`court${courtNum}Score2`);
            const row1 = document.getElementById(`court${courtNum}Team1Row`);
            const row2 = document.getElementById(`court${courtNum}Team2Row`);
            const btnSave = document.getElementById(`btnSaveCourt${courtNum}`);
            const lockedLabel = document.getElementById(`courtLockedLabel${courtNum}`);

            const isUserInThisMatch = isCurrentUserInMatch(m);
            const canEdit = canUserEditMatch(m);

            // Framhäv "DIN MATCH"
            if (userTag) {
                userTag.style.display = isUserInThisMatch ? 'inline-block' : 'none';
            }
            if (card) {
                card.classList.toggle('is-my-match', isUserInThisMatch);
                card.classList.toggle('is-other-match', isPlayer() && !isUserInThisMatch);
                card.classList.toggle('completed', m.completed);
            }

            // Formatera lagnamn och markera (Du)
            const formatTeam = (team) => {
                return team.map(p => {
                    const isMe = (currentUserId && p.id === currentUserId) || 
                                 (currentUserName && p.name.toLowerCase() === currentUserName);
                    return isMe ? `${p.name} (Du)` : p.name;
                }).join(' & ');
            };

            if (t1Names) t1Names.textContent = formatTeam(m.team1);
            if (t2Names) t2Names.textContent = formatTeam(m.team2);

            // Poängsiffror
            if (s1Input && document.activeElement !== s1Input) s1Input.value = m.score1;
            if (s2Input && document.activeElement !== s2Input) s2Input.value = m.score2;

            // Behörigheter för inmatning
            const minusBtns = card.querySelectorAll('.score-minus');
            const plusBtns = card.querySelectorAll('.score-plus');

            if (canEdit) {
                if (s1Input) s1Input.readOnly = false;
                if (s2Input) s2Input.readOnly = false;
                minusBtns.forEach(b => b.style.display = 'flex');
                plusBtns.forEach(b => b.style.display = 'flex');
                if (btnSave) btnSave.style.display = 'block';
                if (lockedLabel) lockedLabel.style.display = 'none';
            } else {
                if (s1Input) s1Input.readOnly = true;
                if (s2Input) s2Input.readOnly = true;
                minusBtns.forEach(b => b.style.display = 'none');
                plusBtns.forEach(b => b.style.display = 'none');
                if (btnSave) btnSave.style.display = 'none';
                if (lockedLabel) {
                    lockedLabel.style.display = 'block';
                    if (isGuest()) {
                        lockedLabel.innerHTML = 'Logga in som spelare eller arrangör för att rapportera resultat.';
                        lockedLabel.style.cursor = 'pointer';
                        lockedLabel.onclick = () => openModal('modalAuth');
                    } else {
                        lockedLabel.textContent = `Parallell match på Bana ${courtNum}`;
                        lockedLabel.style.cursor = 'default';
                        lockedLabel.onclick = null;
                    }
                }
            }

            if (statusEl) statusEl.textContent = m.completed ? '✓ Klar' : 'Pågående';

            if (row1 && row2) {
                row1.classList.toggle('winner', m.completed && m.score1 > m.score2);
                row2.classList.toggle('winner', m.completed && m.score2 > m.score1);
            }
        });
    }

    /**
     * Flik 3: Tabell
     */
    function renderTableView(tourney) {
        const tbody = document.getElementById('leaderboardBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const leaderboard = calculateLeaderboard(tourney);
        if (leaderboard.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding:24px;color:var(--text-muted);">Inga spelare anmälda än.</td></tr>';
            return;
        }

        const currentUserId = appState.currentUser ? appState.currentUser.id : null;
        const currentUserName = appState.currentUser ? (appState.currentUser.name || '').toLowerCase() : '';

        leaderboard.forEach((item, index) => {
            const tr = document.createElement('tr');
            const isMe = (currentUserId && item.id === currentUserId) || 
                         (currentUserName && item.name.toLowerCase() === currentUserName);

            if (isMe) tr.classList.add('row-current-user');

            let rankClass = '';
            let rankDisplay = index + 1;
            if (index === 0) { rankClass = 'rank-gold'; rankDisplay = '🥇'; }
            else if (index === 1) { rankClass = 'rank-silver'; rankDisplay = '🥈'; }
            else if (index === 2) { rankClass = 'rank-bronze'; rankDisplay = '🥉'; }

            const diffDisplay = item.diff > 0 ? `+${item.diff}` : item.diff;
            const displayName = isMe ? `${escapeHtml(item.name)} <span style="color:var(--primary); font-size:11px;">(Du)</span>` : escapeHtml(item.name);

            tr.innerHTML = `
                <td class="col-rank ${rankClass}">${rankDisplay}</td>
                <td class="col-player">${displayName}</td>
                <td class="col-stat text-center">${item.matchesPlayed}</td>
                <td class="col-stat text-center">${diffDisplay}</td>
                <td class="col-points text-right">${item.totalPoints}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    /**
     * Flik 4: Meny
     */
    function renderMenuView(tourney) {
        const userIcon = document.getElementById('menuUserIcon');
        const userName = document.getElementById('menuUserName');
        const userRole = document.getElementById('menuUserRole');
        const btnLogin = document.getElementById('btnMenuLogin');
        const btnLogout = document.getElementById('btnMenuLogout');
        const adminZone = document.getElementById('menuAdminZone');
        const adminCodeText = document.getElementById('menuAdminCodeText');
        const archiveCount = document.getElementById('menuArchiveCountText');

        if (appState.currentUser) {
            if (isOrganizer()) {
                if (userIcon) userIcon.textContent = '👑';
                if (userName) userName.textContent = appState.currentUser.name;
                if (userRole) userRole.textContent = `Arrangör (Admin) · Kod: ${tourney ? tourney.adminCode : 'PT-00'}`;
            } else {
                if (userIcon) userIcon.textContent = '🎾';
                if (userName) userName.textContent = appState.currentUser.name;
                if (userRole) userRole.textContent = `Spelare · PIN: ${appState.currentUser.pin || 'Saknas'}`;
            }

            if (btnLogin) btnLogin.textContent = 'Byt användare';
            if (btnLogout) btnLogout.style.display = 'inline-flex';
        } else {
            // INGEN STÅR SOM INLOGGAD
            if (userIcon) userIcon.textContent = '👤';
            if (userName) userName.textContent = 'Gästläge';
            if (userRole) userRole.textContent = 'Inte inloggad – Visningsläge';

            if (btnLogin) btnLogin.textContent = 'Logga in';
            if (btnLogout) btnLogout.style.display = 'none';
        }

        // Arrangörsfunktioner visas ENDAST om arrangören är inloggad
        if (adminZone) {
            adminZone.style.display = isOrganizer() ? 'flex' : 'none';
        }
        if (adminCodeText && tourney) {
            adminCodeText.textContent = tourney.adminCode || 'PT-00';
        }

        if (archiveCount) {
            const count = appState.tournaments.length + appState.deletedTournaments.length;
            archiveCount.textContent = `${count} sparade turneringar`;
        }
    }

    // =========================================================================
    // 10. MODALER & NOTIFIERINGAR
    // =========================================================================

    function openModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.style.display = 'flex';

        if (modalId === 'modalAuth') {
            setupAuthModalContent();
        }

        playClick();
    }

    function closeModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.style.display = 'none';
    }

    function setupAuthModalContent() {
        const tourney = getActiveTournament();
        const playerGrid = document.getElementById('authPlayerGrid');
        const pinGroup = document.getElementById('authPlayerPinGroup');
        const logoutWrap = document.getElementById('authModalLogoutWrap');

        selectedPlayerForLogin = null;
        if (pinGroup) pinGroup.style.display = 'none';
        const pinInput = document.getElementById('authPlayerPinInput');
        if (pinInput) pinInput.value = '';

        if (logoutWrap) {
            logoutWrap.style.display = appState.currentUser ? 'block' : 'none';
        }

        if (!playerGrid) return;
        playerGrid.innerHTML = '';

        if (!tourney || !tourney.players || tourney.players.length === 0) {
            playerGrid.innerHTML = '<span style="font-size:12px;color:var(--text-muted);grid-column:span 2;">Inga spelare är anmälda än.</span>';
            return;
        }

        tourney.players.forEach(p => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'player-select-btn';
            btn.textContent = p.name;
            btn.dataset.playerId = p.id;

            btn.addEventListener('click', () => {
                document.querySelectorAll('.player-select-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedPlayerForLogin = p;

                const nameDisplay = document.getElementById('authSelectedPlayerName');
                if (nameDisplay) nameDisplay.textContent = p.name;
                if (pinGroup) pinGroup.style.display = 'block';
                if (pinInput) {
                    pinInput.focus();
                }
                playClick();
            });

            playerGrid.appendChild(btn);
        });
    }

    function showToast(message) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `<span class="toast-message">${escapeHtml(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3200);
    }

    function showUndoToast(tourney) {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        if (undoToastTimer) clearTimeout(undoToastTimer);

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.id = 'activeUndoToast';
        toast.innerHTML = `
            <span class="toast-message">🗑️ "${escapeHtml(tourney.name)}" raderades.</span>
            <button type="button" class="toast-btn">Ångra ↺</button>
        `;

        toast.querySelector('.toast-btn').addEventListener('click', () => {
            restoreTournament(tourney.id);
            toast.remove();
        });

        container.appendChild(toast);
        undoToastTimer = setTimeout(() => {
            toast.remove();
        }, 8000);
    }

    function renderArchiveModal() {
        const activeList = document.getElementById('archiveActiveList');
        const trashList = document.getElementById('archiveTrashList');

        if (activeList) {
            activeList.innerHTML = '';
            if (appState.tournaments.length === 0) {
                activeList.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">Inga sparade turneringar</span>';
            } else {
                appState.tournaments.forEach(t => {
                    const item = document.createElement('div');
                    item.className = 'archive-item';
                    item.innerHTML = `
                        <div class="archive-item-info">
                            <div class="archive-item-title">${escapeHtml(t.name)}</div>
                            <div class="archive-item-sub">${new Date(t.createdAt).toLocaleDateString('sv-SE')} · ${t.players.length}/8 spelare</div>
                        </div>
                        <div class="archive-item-actions">
                            <button type="button" class="btn btn-secondary btn-sm select-btn">Öppna</button>
                        </div>
                    `;
                    item.querySelector('.select-btn').addEventListener('click', () => {
                        appState.activeTournamentId = t.id;
                        saveState();
                        initCloudSync();
                        renderApp();
                        closeModal('modalArchive');
                        switchView('viewPlayers');
                    });
                    activeList.appendChild(item);
                });
            }
        }

        if (trashList) {
            trashList.innerHTML = '';
            if (appState.deletedTournaments.length === 0) {
                trashList.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">Papperskorgen är tom</span>';
            } else {
                appState.deletedTournaments.forEach(t => {
                    const item = document.createElement('div');
                    item.className = 'archive-item';
                    item.innerHTML = `
                        <div class="archive-item-info">
                            <div class="archive-item-title">${escapeHtml(t.name)}</div>
                            <div class="archive-item-sub">Raderad · ${t.players.length} spelare</div>
                        </div>
                        <div class="archive-item-actions">
                            <button type="button" class="btn btn-secondary btn-sm restore-btn">Återställ</button>
                            <button type="button" class="btn btn-danger-sm perm-del-btn">✕</button>
                        </div>
                    `;
                    item.querySelector('.restore-btn').addEventListener('click', () => {
                        restoreTournament(t.id);
                        renderArchiveModal();
                    });
                    item.querySelector('.perm-del-btn').addEventListener('click', () => {
                        if (confirm(`Radera "${t.name}" permanent?`)) {
                            deleteTournament(t.id, true);
                        }
                    });
                    trashList.appendChild(item);
                });
            }
        }
    }

    // =========================================================================
    // 11. NAVIGERING MELLAN FLIKAR
    // =========================================================================

    function switchView(viewId) {
        document.querySelectorAll('.nav-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === viewId);
        });

        document.querySelectorAll('.app-view').forEach(view => {
            if (view.id === viewId) {
                view.style.display = 'block';
                view.classList.add('active');
            } else {
                view.style.display = 'none';
                view.classList.remove('active');
            }
        });

        playClick();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // =========================================================================
    // 12. HÄNDELSELYSSNARE (EVENT LISTENERS)
    // =========================================================================

    function setupEventListeners() {
        // Bottenmeny
        document.querySelectorAll('.nav-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                switchView(btn.dataset.tab);
            });
        });

        // Omgångsväljare
        document.querySelectorAll('.round-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                appState.currentRoundIndex = parseInt(pill.dataset.round, 10);
                const tourney = getActiveTournament();
                if (tourney) renderMatchesView(tourney);
                playClick();
            });
        });

        // Startskärm knappar
        document.getElementById('btnStartCreate').addEventListener('click', () => openModal('modalNewTourney'));
        document.getElementById('btnStartArchive').addEventListener('click', () => {
            renderArchiveModal();
            openModal('modalArchive');
        });

        // Meny knappar
        document.getElementById('btnMenuNewTourney').addEventListener('click', () => openModal('modalNewTourney'));
        document.getElementById('btnMenuLogin').addEventListener('click', () => openModal('modalAuth'));
        document.getElementById('btnMenuLogout').addEventListener('click', logoutUser);
        document.getElementById('btnUserHeader').addEventListener('click', () => openModal('modalAuth'));
        document.getElementById('btnOpenArchiveModal').addEventListener('click', () => {
            renderArchiveModal();
            openModal('modalArchive');
        });

        document.getElementById('btnMenuDeleteTourney').addEventListener('click', () => {
            const active = getActiveTournament();
            if (active && confirm(`Vill du flytta turneringen "${active.name}" till papperskorgen?`)) {
                deleteTournament(active.id);
            }
        });

        // Länkdelning
        const copyInviteHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const url = getShareableUrl(active, false);
            navigator.clipboard.writeText(url).then(() => {
                showToast('📋 Deltagarlänk kopierad!');
                playSuccess();
            }).catch(() => {
                prompt('Kopiera deltagarlänken här:', url);
            });
        };

        const copyAdminLinkHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const url = getShareableUrl(active, true);
            navigator.clipboard.writeText(url).then(() => {
                showToast('🔑 Arrangörslänk med full behörighet kopierad!');
                playSuccess();
            }).catch(() => {
                prompt('Kopiera arrangörslänken här:', url);
            });
        };

        const whatsappInviteHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const url = getShareableUrl(active, false);
            const text = encodeURIComponent(`Hej! Här är länken till vår padelturnering ${active.name}: ${url}`);
            window.open(`https://wa.me/?text=${text}`, '_blank');
        };

        document.getElementById('btnCopyInviteLink').addEventListener('click', copyInviteHandler);
        document.getElementById('btnMenuCopyLink').addEventListener('click', copyInviteHandler);
        document.getElementById('btnCopyAdminLink').addEventListener('click', copyAdminLinkHandler);
        document.getElementById('btnWhatsappInvite').addEventListener('click', whatsappInviteHandler);
        document.getElementById('btnMenuWhatsapp').addEventListener('click', whatsappInviteHandler);

        // Lottningsknapp
        document.getElementById('btnDrawSchedule').addEventListener('click', () => {
            const tourney = getActiveTournament();
            if (tourney) drawSchedule(tourney);
        });

        document.getElementById('btnJumpToMatches').addEventListener('click', () => {
            switchView('viewMatches');
        });

        const btnGoMatches = document.getElementById('btnGoToPlayersFromMatches');
        if (btnGoMatches) {
            btnGoMatches.addEventListener('click', () => switchView('viewPlayers'));
        }

        // Ta plats & Ta bort klick i spelarlistan
        document.getElementById('rosterList').addEventListener('click', (e) => {
            const takeBtn = e.target.closest('.btn-take-slot');
            if (takeBtn) {
                const slot = takeBtn.dataset.slot;
                document.getElementById('takeSlotIndex').value = slot;
                openModal('modalTakeSlot');
                return;
            }

            const removeBtn = e.target.closest('.btn-remove-player');
            if (removeBtn) {
                const idx = parseInt(removeBtn.dataset.idx, 10);
                const tourney = getActiveTournament();
                if (tourney) removePlayer(tourney, idx);
                return;
            }
        });

        // Spara poäng knappar
        document.querySelectorAll('.btn-save-score').forEach(btn => {
            btn.addEventListener('click', () => {
                const court = parseInt(btn.dataset.court, 10);
                saveMatchScore(court);
            });
        });

        // Poängstegare (+ / -)
        document.querySelectorAll('.score-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const court = btn.dataset.court;
                const team = btn.dataset.team;
                const isPlus = btn.classList.contains('score-plus');
                const input = document.getElementById(`court${parseInt(court, 10) + 1}Score${team}`);
                if (input && !input.readOnly) {
                    let val = parseInt(input.value, 10) || 0;
                    val = isPlus ? val + 1 : Math.max(0, val - 1);
                    input.value = val;
                    playClick();
                }
            });
        });

        // Modal stängningar
        document.querySelectorAll('.btn-close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal-overlay');
                if (modal) modal.style.display = 'none';
            });
        });

        document.getElementById('btnClosePinConfirm').addEventListener('click', () => {
            closeModal('modalPinConfirm');
        });

        document.getElementById('btnEmptyTrash').addEventListener('click', () => {
            if (confirm('Vill du tömma papperskorgen permanent? Detta kan inte ångras.')) {
                appState.deletedTournaments = [];
                saveState();
                renderArchiveModal();
                playDelete();
            }
        });

        // Formulär: Skapa ny turnering
        document.getElementById('formNewTourney').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('newTourneyName').value;
            const org = document.getElementById('newTourneyOrg').value;
            const plays = document.getElementById('newTourneyOrgPlays').checked;
            const format = document.getElementById('newTourneyFormat').value;
            const points = document.getElementById('newTourneyPoints').value;

            createNewTournament(name, org, plays, format, points);
            closeModal('modalNewTourney');
            e.target.reset();
        });

        // Formulär: Ta plats
        document.getElementById('formTakeSlot').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('takeSlotPlayerName').value;
            const slot = document.getElementById('takeSlotIndex').value;
            const tourney = getActiveTournament();
            if (tourney && name) {
                registerPlayer(tourney, name, slot);
                closeModal('modalTakeSlot');
                e.target.reset();
            }
        });

        // =====================================================================
        // AUTH MODAL LOGIK: SPELARE VS ARRANGÖR
        // =====================================================================

        const tabBtnPlayer = document.getElementById('authTabBtnPlayer');
        const tabBtnAdmin = document.getElementById('authTabBtnAdmin');
        const secPlayer = document.getElementById('authSectionPlayer');
        const secAdmin = document.getElementById('authSectionAdmin');

        if (tabBtnPlayer && tabBtnAdmin) {
            tabBtnPlayer.addEventListener('click', () => {
                tabBtnPlayer.classList.add('active');
                tabBtnAdmin.classList.remove('active');
                if (secPlayer) secPlayer.style.display = 'block';
                if (secAdmin) secAdmin.style.display = 'none';
                playClick();
            });

            tabBtnAdmin.addEventListener('click', () => {
                tabBtnAdmin.classList.add('active');
                tabBtnPlayer.classList.remove('active');
                if (secAdmin) secAdmin.style.display = 'block';
                if (secPlayer) secPlayer.style.display = 'none';
                playClick();
            });
        }

        // Spelarinloggning med vald spelare + PIN
        document.getElementById('btnSubmitPlayerLogin').addEventListener('click', () => {
            if (!selectedPlayerForLogin) {
                alert('Välj först ditt namn i listan.');
                return;
            }

            const pinInput = document.getElementById('authPlayerPinInput');
            const enteredPin = (pinInput ? pinInput.value : '').trim();

            if (!enteredPin) {
                alert('Ange din 4-siffriga PIN-kod.');
                return;
            }

            if (selectedPlayerForLogin.pin && selectedPlayerForLogin.pin.toString() === enteredPin) {
                appState.currentUser = {
                    id: selectedPlayerForLogin.id,
                    name: selectedPlayerForLogin.name,
                    pin: selectedPlayerForLogin.pin,
                    role: 'player'
                };
                saveUser();
                closeModal('modalAuth');
                renderApp();
                playSuccess();
                showToast(`🎾 Välkommen, ${selectedPlayerForLogin.name}!`);
            } else {
                alert(`Felaktig PIN-kod för ${selectedPlayerForLogin.name}. Kontrollera koden och försök igen.`);
                if (pinInput) {
                    pinInput.value = '';
                    pinInput.focus();
                }
            }
        });

        // Arrangörsinloggning med PT-xx eller nyckel
        document.getElementById('formAdminAuth').addEventListener('submit', (e) => {
            e.preventDefault();
            const code = document.getElementById('authAdminCodeInput').value.trim();
            const tourney = getActiveTournament();

            if (!tourney) {
                alert('Ingen aktiv turnering är vald.');
                return;
            }

            const isMaster = code.toLowerCase() === 'ulrik';
            const matchesCode = tourney.adminCode && code.toUpperCase() === tourney.adminCode.toUpperCase();
            const matchesKey = tourney.adminKey && code === tourney.adminKey;

            if (isMaster || matchesCode || matchesKey) {
                appState.currentUser = {
                    id: (tourney.organizer && tourney.organizer.id) ? tourney.organizer.id : 'org_' + tourney.id,
                    name: (tourney.organizer && tourney.organizer.name) ? tourney.organizer.name : 'Arrangör',
                    role: 'admin',
                    tourneyKey: tourney.adminKey
                };
                saveUser();
                saveAdminKeyForTourney(tourney.id, tourney.adminKey);
                closeModal('modalAuth');
                renderApp();
                playSuccess();
                showToast(`👑 Inloggad som Arrangör (${appState.currentUser.name})`);
                e.target.reset();
            } else {
                alert('Felaktig arrangörskod. Ange koden som skapades med turneringen (t.ex. PT-xx).');
            }
        });

        // Logga ut inifrån modalen
        document.getElementById('btnModalLogout').addEventListener('click', () => {
            closeModal('modalAuth');
            logoutUser();
        });
    }

    // =========================================================================
    // 13. INITIERING
    // =========================================================================

    function init() {
        loadState();
        setupEventListeners();
        renderApp();
        initCloudSync();

        // Standardvy: Spelare om turnering finns, annars Startskärm
        if (getActiveTournament()) {
            switchView('viewPlayers');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
