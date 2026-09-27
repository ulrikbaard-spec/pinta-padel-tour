/**
 * PINTA PADEL TOUR – HUVUDMOTOR
 * Minimalistisk, serverlös padelturnering för 8 spelare på 2 banor.
 * Byggd enligt direktiven i skill:en frontend-design.
 */

(function () {
    'use strict';

    // =========================================================================
    // 1. KONSTANTER & TILLSTÅND (STATE)
    // =========================================================================

    const STORAGE_KEY = 'pinta_padel_data_v2';
    const AUTH_KEY = 'pinta_padel_user_v2';
    const ADMIN_KEYS_KEY = 'pinta_padel_adminkeys_v2';

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

        // Om skaparen besöker sin egen turnering och adminKey stämmer -> arrangör
        const active = getActiveTournament();
        if (active && !appState.currentUser) {
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
            } else {
                localStorage.removeItem(AUTH_KEY);
            }
        } catch (e) {}
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
        const hash = window.location.hash;

        if (hash && hash.startsWith('#data=')) {
            try {
                const encoded = hash.replace('#data=', '');
                const decompressed = decodeURIComponent(atob(encoded));
                const imported = JSON.parse(decompressed);
                if (imported && imported.id) {
                    const idx = appState.tournaments.findIndex(t => t.id === imported.id);
                    if (idx >= 0) {
                        appState.tournaments[idx] = imported;
                    } else {
                        appState.tournaments.push(imported);
                    }
                    appState.activeTournamentId = imported.id;
                    saveState();
                }
            } catch (e) {}
        } else if (tourneyId) {
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
        if (adminKeyParam && active) {
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

    function getShareableUrl(tourney) {
        if (!tourney) return window.location.origin + window.location.pathname;
        const base = window.location.origin + window.location.pathname;
        const cleanName = encodeURIComponent(tourney.name || 'Padel');
        return `${base}?t=${tourney.id}&n=${cleanName}`;
    }

    // =========================================================================
    // 6. TURNERINGSHANTERING (SKAPA, LOTTA, RADERA)
    // =========================================================================

    function getActiveTournament() {
        return appState.tournaments.find(t => t.id === appState.activeTournamentId) || null;
    }

    function isUserOrganizerOf(tourney) {
        if (!tourney) return false;
        if (!appState.currentUser) return false;
        if (appState.currentUser.role === 'admin') return true;
        const keys = getAdminKeys();
        if (tourney.adminKey && keys[tourney.id] === tourney.adminKey) return true;
        return false;
    }

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

        // Om arrangören spelar själv -> sätts direkt på Plats 1 med egen PIN-kod
        if (organizerPlays) {
            const orgPin = Math.floor(1000 + Math.random() * 9000).toString();
            newTourney.players.push({
                id: 'p_1_' + Date.now(),
                name: orgCleanName,
                pin: orgPin,
                isOrganizer: true
            });
        }

        saveAdminKeyForTourney(id, adminKey);
        appState.tournaments.unshift(newTourney);
        appState.activeTournamentId = id;

        // Skaparen är alltid inloggad som arrangör på denna enhet
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

        // Om arrangören lägger till en spelare -> ARRANGÖREN FÖRMÅR VARA ARRANGÖR!
        const isOrg = appState.currentUser && appState.currentUser.role === 'admin';
        if (!isOrg) {
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

        // Visa PIN-bekräftelse
        showPinConfirmModal(newPlayer.name, newPlayer.pin);
        playSuccess();
        return true;
    }

    function removePlayer(tourney, playerIndex) {
        if (!tourney || tourney.isDrawn) return;
        if (!isUserOrganizerOf(tourney)) {
            alert('Endast turneringens arrangör kan ta bort anmälda spelare.');
            return;
        }
        if (confirm(`Ta bort ${tourney.players[playerIndex].name}?`)) {
            tourney.players.splice(playerIndex, 1);
            saveState();
            renderApp();
            playClick();
        }
    }

    /**
     * Lottning av spelschemat för 8 spelare (7 omgångar)
     */
    function drawSchedule(tourney) {
        if (!tourney || tourney.isDrawn) return;
        if (tourney.players.length !== 8) {
            alert('Alla 8 platser måste vara fyllda innan lottning kan genomföras.');
            return;
        }
        if (!isUserOrganizerOf(tourney)) {
            alert('Endast arrangören kan genomföra lottningen.');
            return;
        }

        // Slumpa spelarnas ordning 1..8 för rättvis lottning
        const shuffledPlayers = [...tourney.players].sort(() => Math.random() - 0.5);
        tourney.players = shuffledPlayers;

        const rounds = [];
        SCHEDULE_MATRIX.forEach((roundData, rIndex) => {
            const court1Pairs = roundData.court1;
            const court2Pairs = roundData.court2;

            rounds.push({
                roundNumber: rIndex + 1,
                matches: [
                    {
                        court: 1,
                        team1: [shuffledPlayers[court1Pairs[0][0]], shuffledPlayers[court1Pairs[0][1]]],
                        team2: [shuffledPlayers[court1Pairs[1][0]], shuffledPlayers[court1Pairs[1][1]]],
                        score1: 0,
                        score2: 0,
                        completed: false
                    },
                    {
                        court: 2,
                        team1: [shuffledPlayers[court2Pairs[0][0]], shuffledPlayers[court2Pairs[0][1]]],
                        team2: [shuffledPlayers[court2Pairs[1][0]], shuffledPlayers[court2Pairs[1][1]]],
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
    // 7. RESULTAT & TABELLBERÄKNING
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
            // I Game-räkning är totalpoängen antalet vunna game
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
    // 8. RENDERING & UI-UPPDATERINGAR
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

    function renderUserStatus() {
        const btnUser = document.getElementById('btnUserHeader');
        const iconEl = document.getElementById('headerUserIcon');
        const nameEl = document.getElementById('headerUserName');

        if (appState.currentUser) {
            if (iconEl) iconEl.textContent = appState.currentUser.role === 'admin' ? '👑' : '🎾';
            if (nameEl) nameEl.textContent = appState.currentUser.name;
        } else {
            if (iconEl) iconEl.textContent = '👤';
            if (nameEl) nameEl.textContent = 'Logga in';
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

        const isOrg = isUserOrganizerOf(tourney);

        for (let i = 0; i < 8; i++) {
            const player = tourney.players[i];
            const row = document.createElement('div');
            row.className = 'roster-slot-row';

            if (player) {
                row.innerHTML = `
                    <div class="slot-left">
                        <span class="slot-index">${i + 1}</span>
                        <span class="slot-name">${escapeHtml(player.name)}</span>
                    </div>
                    <div class="slot-badges">
                        ${player.isOrganizer ? '<span class="badge-organizer">Arrangör</span>' : ''}
                        ${(!tourney.isDrawn && isOrg) ? `<button type="button" class="btn-remove-player" data-idx="${i}" title="Ta bort">✕</button>` : ''}
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
                if (count === 8) {
                    btnDraw.disabled = false;
                    btnDraw.textContent = '🎲 Lotta spelschema';
                } else {
                    btnDraw.disabled = true;
                    btnDraw.textContent = `Lotta spelschema (${8 - count} platser kvar)`;
                }
            }
        }
    }

    /**
     * Flik 2: Matcher
     */
    function renderMatchesView(tourney) {
        const notDrawnBox = document.getElementById('notDrawnBox');
        const activeContainer = document.getElementById('matchesActiveContainer');
        const roundPicker = document.getElementById('roundPicker');

        if (!tourney.isDrawn || !tourney.rounds || tourney.rounds.length === 0) {
            if (notDrawnBox) notDrawnBox.style.display = 'block';
            if (activeContainer) activeContainer.style.display = 'none';
            return;
        }

        if (notDrawnBox) notDrawnBox.style.display = 'none';
        if (activeContainer) activeContainer.style.display = 'flex';

        // Uppdatera piller
        document.querySelectorAll('.round-pill').forEach((pill, idx) => {
            pill.classList.toggle('active', idx === appState.currentRoundIndex);
        });

        const round = tourney.rounds[appState.currentRoundIndex];
        if (!round || !round.matches) return;

        // Rendera Bana 1 & Bana 2
        round.matches.forEach((m, cIdx) => {
            const card = document.getElementById(`courtCard${cIdx + 1}`);
            const statusEl = document.getElementById(`courtStatus${cIdx + 1}`);
            const t1Names = document.getElementById(`court${cIdx + 1}Team1Names`);
            const t2Names = document.getElementById(`court${cIdx + 1}Team2Names`);
            const s1Input = document.getElementById(`court${cIdx + 1}Score1`);
            const s2Input = document.getElementById(`court${cIdx + 1}Score2`);
            const row1 = document.getElementById(`court${cIdx + 1}Team1Row`);
            const row2 = document.getElementById(`court${cIdx + 1}Team2Row`);

            if (t1Names) t1Names.textContent = `${m.team1[0].name} & ${m.team1[1].name}`;
            if (t2Names) t2Names.textContent = `${m.team2[0].name} & ${m.team2[1].name}`;

            if (s1Input && document.activeElement !== s1Input) s1Input.value = m.score1;
            if (s2Input && document.activeElement !== s2Input) s2Input.value = m.score2;

            if (card) card.classList.toggle('completed', m.completed);
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

        leaderboard.forEach((item, index) => {
            const tr = document.createElement('tr');
            let rankClass = '';
            let rankDisplay = index + 1;
            if (index === 0) { rankClass = 'rank-gold'; rankDisplay = '🥇'; }
            else if (index === 1) { rankClass = 'rank-silver'; rankDisplay = '🥈'; }
            else if (index === 2) { rankClass = 'rank-bronze'; rankDisplay = '🥉'; }

            const diffDisplay = item.diff > 0 ? `+${item.diff}` : item.diff;

            tr.innerHTML = `
                <td class="col-rank ${rankClass}">${rankDisplay}</td>
                <td class="col-player">${escapeHtml(item.name)}</td>
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
        const archiveCount = document.getElementById('menuArchiveCountText');

        if (appState.currentUser) {
            if (userIcon) userIcon.textContent = appState.currentUser.role === 'admin' ? '👑' : '🎾';
            if (userName) userName.textContent = appState.currentUser.name;
            if (userRole) {
                userRole.textContent = appState.currentUser.role === 'admin' 
                    ? 'Arrangör (Admin)' 
                    : `Spelare ${appState.currentUser.pin ? '· PIN: ' + appState.currentUser.pin : ''}`;
            }
        } else {
            if (userIcon) userIcon.textContent = '👤';
            if (userName) userName.textContent = 'Gästläge';
            if (userRole) userRole.textContent = 'Visningsläge – Logga in för att rapportera';
        }

        if (archiveCount) {
            const count = appState.tournaments.length + appState.deletedTournaments.length;
            archiveCount.textContent = `${count} sparade turneringar`;
        }
    }

    // =========================================================================
    // 9. MODALER & NOTIFIERINGAR
    // =========================================================================

    function openModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.style.display = 'flex';
        playClick();
    }

    function closeModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.style.display = 'none';
    }

    function showPinConfirmModal(name, pin) {
        document.getElementById('pinConfirmName').textContent = name;
        document.getElementById('pinConfirmCode').textContent = pin;
        openModal('modalPinConfirm');
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
    // 10. NAVIGERING MELLAN FLIKAR
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
    // 11. HÄNDELSELYSSNARE (EVENT LISTENERS)
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
        const copyHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const url = getShareableUrl(active);
            navigator.clipboard.writeText(url).then(() => {
                showToast('📋 Inbjudningslänk kopierad till urklipp!');
                playSuccess();
            }).catch(() => {
                prompt('Kopiera länken här:', url);
            });
        };

        const whatsappHandler = () => {
            const active = getActiveTournament();
            if (!active) return;
            const url = getShareableUrl(active);
            const text = encodeURIComponent(`Hej! Här är länken till vår padelturnering ${active.name}: ${url}`);
            window.open(`https://wa.me/?text=${text}`, '_blank');
        };

        document.getElementById('btnCopyInviteLink').addEventListener('click', copyHandler);
        document.getElementById('btnMenuCopyLink').addEventListener('click', copyHandler);
        document.getElementById('btnWhatsappInvite').addEventListener('click', whatsappHandler);
        document.getElementById('btnMenuWhatsapp').addEventListener('click', whatsappHandler);

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

        // Ta plats klick
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
                if (input) {
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

        // Formulär: Logga in
        document.getElementById('formAuth').addEventListener('submit', (e) => {
            e.preventDefault();
            const code = document.getElementById('authCodeInput').value.trim();
            const tourney = getActiveTournament();

            if (!tourney) {
                alert('Ingen aktiv turnering är vald.');
                return;
            }

            // Arrangörsinloggning med PT-xx eller nyckel
            if (code.toLowerCase() === 'ulrik' || 
                (tourney.adminCode && code.toUpperCase() === tourney.adminCode.toUpperCase()) ||
                (tourney.adminKey && code === tourney.adminKey)) {
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
                return;
            }

            // Spelarinloggning med 4-siffrig PIN
            const foundPlayer = tourney.players.find(p => p.pin && p.pin.toString() === code);
            if (foundPlayer) {
                appState.currentUser = {
                    id: foundPlayer.id,
                    name: foundPlayer.name,
                    pin: foundPlayer.pin,
                    role: 'player'
                };
                saveUser();
                closeModal('modalAuth');
                renderApp();
                playSuccess();
                showToast(`🎾 Inloggad som Spelare (${foundPlayer.name})`);
                e.target.reset();
                return;
            }

            alert('Felaktig kod. Ange din 4-siffriga spelar-PIN eller arrangörskoden (PT-xx).');
        });

        document.getElementById('btnAuthLogout').addEventListener('click', () => {
            appState.currentUser = null;
            saveUser();
            closeModal('modalAuth');
            renderApp();
            playClick();
            showToast('Du är nu i gästläge.');
        });
    }

    // =========================================================================
    // 12. INITIERING
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
